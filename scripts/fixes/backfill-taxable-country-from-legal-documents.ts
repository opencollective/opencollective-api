/**
 * Backfills `taxableCountry` and `isUSEntity` on accounts that have a received
 * legal document but are missing these derived fields.
 *
 * Values are derived from the most recent RECEIVED US tax form submitted through
 * our own form flow (`data.encryptedFormData`). Legacy HelloWorks/Dropbox Forms
 * documents and manually uploaded PDFs have no usable form data and are counted
 * as skipped.
 *
 * Only missing keys are written; existing values are never overwritten. Writes
 * use atomic `jsonb_set` expressions so concurrent writers of other
 * `collective.data` keys are not clobbered.
 *
 * Usage:
 *   DRY_RUN=false npm run script scripts/fixes/backfill-taxable-country-from-legal-documents.ts
 */

import '../../server/env';

import { Command } from 'commander';
import { cast, col, fn, literal, Op, WhereOptions } from 'sequelize';

import logger from '../../server/lib/logger';
import {
  getIsUSEntityFromFormData,
  getTaxableCountryFromFormData,
  W8BenETaxFormValues,
  W8BenTaxFormValues,
  W9TaxFormValues,
} from '../../server/lib/tax-forms/opencollective';
import { Collective, LegalDocument } from '../../server/models';
import {
  LEGAL_DOCUMENT_REQUEST_STATUS,
  LEGAL_DOCUMENT_SERVICE,
  LEGAL_DOCUMENT_TYPE,
} from '../../server/models/LegalDocument';

const DRY_RUN = process.env.DRY_RUN !== 'false';

type TaxDataSkipReason =
  'LEGACY_HELLOWORKS' | 'MANUAL_UPLOAD' | 'NO_ENCRYPTED_FORM_DATA' | 'UNDECRYPTABLE_PAYLOAD' | 'NO_DERIVABLE_VALUE';

type DerivedTaxData = {
  taxableCountry: string | null;
  isUSEntity: boolean | null;
};

type LegalDocumentTaxDataResult =
  ({ status: 'DERIVED'; formType: string | null } & DerivedTaxData) | { status: 'SKIPPED'; reason: TaxDataSkipReason };

type BackfillUpdates = {
  taxableCountry?: string;
  isUSEntity?: boolean;
};

type AccountBackfillResult =
  | {
      status: 'UPDATED' | 'WOULD_UPDATE';
      legalDocumentId: number;
      formType: string | null;
      updates: BackfillUpdates;
    }
  | { status: 'NOTHING_TO_FILL' }
  | { status: 'NO_USABLE_DOCUMENT'; skippedReasons: TaxDataSkipReason[] };

type BackfillSummary = {
  scanned: number;
  updated: number;
  wouldUpdate: number;
  nothingToFill: number;
  noUsableDocument: number;
  skippedReasons: Partial<Record<TaxDataSkipReason, number>>;
};

/**
 * Decrypts a legal document's form data and derives the taxable country and
 * US-entity status from it. Returns a skip reason when the document carries no
 * usable form data (legacy HelloWorks, manual upload, undecryptable payload).
 */
export const deriveTaxDataFromLegalDocument = (legalDocument: LegalDocument): LegalDocumentTaxDataResult => {
  const { data, service } = legalDocument;

  if (service === LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS || data?.helloWorks?.instance) {
    return { status: 'SKIPPED', reason: 'LEGACY_HELLOWORKS' };
  } else if (data?.isManual) {
    return { status: 'SKIPPED', reason: 'MANUAL_UPLOAD' };
  } else if (!data?.encryptedFormData) {
    return { status: 'SKIPPED', reason: 'NO_ENCRYPTED_FORM_DATA' };
  }

  let formData: W9TaxFormValues | W8BenTaxFormValues | W8BenETaxFormValues;
  try {
    formData = JSON.parse(LegalDocument.decrypt(Buffer.from(data.encryptedFormData, 'base64')).toString());
  } catch {
    return { status: 'SKIPPED', reason: 'UNDECRYPTABLE_PAYLOAD' };
  }

  if (!formData || typeof formData !== 'object') {
    return { status: 'SKIPPED', reason: 'UNDECRYPTABLE_PAYLOAD' };
  }

  const taxableCountry = getTaxableCountryFromFormData(formData);
  const isUSEntity = getIsUSEntityFromFormData(formData);
  if (!taxableCountry && isUSEntity === null) {
    return { status: 'SKIPPED', reason: 'NO_DERIVABLE_VALUE' };
  }

  return {
    status: 'DERIVED',
    formType: formData.formType ? String(formData.formType) : null,
    taxableCountry,
    isUSEntity,
  };
};

/**
 * Backfills the missing tax data of a single account from its most recent
 * usable RECEIVED legal document. Never overwrites existing values.
 */
export const backfillAccountTaxData = async (
  collective: Collective,
  { isDryRun }: { isDryRun: boolean },
): Promise<AccountBackfillResult> => {
  const missingTaxableCountry = !collective.data?.taxableCountry;
  const missingIsUSEntity = collective.data?.isUSEntity === undefined || collective.data?.isUSEntity === null;
  if (!missingTaxableCountry && !missingIsUSEntity) {
    return { status: 'NOTHING_TO_FILL' };
  }

  const legalDocuments = await LegalDocument.findAll({
    where: {
      CollectiveId: collective.id,
      documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
      requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
    },
    // Order by receipt time, not by tax year: `updatedAt` is the submission
    // update for form-flow documents, while a document's `year` can be recorded
    // from its request (historical rows predate the "year = submission year"
    // stamp) and would then pick a stale form.
    order: [['updatedAt', 'DESC']],
  });

  const skippedReasons: TaxDataSkipReason[] = [];
  for (const legalDocument of legalDocuments) {
    const derived = deriveTaxDataFromLegalDocument(legalDocument);
    if (derived.status === 'SKIPPED') {
      skippedReasons.push(derived.reason);
      continue;
    }

    const updates: BackfillUpdates = {};
    if (missingTaxableCountry && derived.taxableCountry) {
      updates.taxableCountry = derived.taxableCountry;
    }
    if (missingIsUSEntity && derived.isUSEntity !== null) {
      updates.isUSEntity = derived.isUSEntity;
    }
    if (!updates.taxableCountry && updates.isUSEntity === undefined) {
      return { status: 'NOTHING_TO_FILL' };
    }

    if (isDryRun) {
      return { status: 'WOULD_UPDATE', legalDocumentId: legalDocument.id, formType: derived.formType, updates };
    }

    // Same atomic write pattern as `submitLegalDocument`: build a single
    // `jsonb_set` expression evaluated against the current row so concurrent
    // writers of other `data` keys (e.g. privateInstructions) are preserved.
    // `literal` only ever carries constant expressions; values go through
    // `cast` and are escaped by the ORM. `hooks: false` is required because a
    // SQL-expression value would make instance hooks read the expression.
    let dataUpdate = fn('COALESCE', col('data'), literal(`'{}'::jsonb`));
    if (updates.taxableCountry) {
      dataUpdate = fn(
        'jsonb_set',
        dataUpdate,
        literal(`'{taxableCountry}'`),
        fn('to_jsonb', cast(updates.taxableCountry, 'text')),
        literal('true'),
      );
    }
    if (updates.isUSEntity !== undefined) {
      dataUpdate = fn(
        'jsonb_set',
        dataUpdate,
        literal(`'{isUSEntity}'`),
        fn('to_jsonb', cast(updates.isUSEntity, 'boolean')),
        literal('true'),
      );
    }
    await collective.update({ data: dataUpdate }, { hooks: false });
    await collective.reload();

    return { status: 'UPDATED', legalDocumentId: legalDocument.id, formType: derived.formType, updates };
  }

  return { status: 'NO_USABLE_DOCUMENT', skippedReasons };
};

export const main = async (options: { isDryRun: boolean; limit?: number; slug?: string }): Promise<BackfillSummary> => {
  const where: WhereOptions = {
    [Op.and]: [
      literal(`("Collective"."data"->>'taxableCountry' IS NULL OR "Collective"."data"->>'isUSEntity' IS NULL)`),
      literal(
        `EXISTS (SELECT 1 FROM "LegalDocuments" ld WHERE ld."CollectiveId" = "Collective"."id" AND ld."deletedAt" IS NULL AND ld."documentType" = 'US_TAX_FORM' AND ld."requestStatus" = 'RECEIVED')`,
      ),
    ],
  };

  const collectives = await Collective.findAll({
    where: options.slug ? { ...where, slug: options.slug } : where,
    order: [['id', 'ASC']],
    limit: options.limit,
  });

  const summary: BackfillSummary = {
    scanned: collectives.length,
    updated: 0,
    wouldUpdate: 0,
    nothingToFill: 0,
    noUsableDocument: 0,
    skippedReasons: {},
  };

  for (const collective of collectives) {
    const result = await backfillAccountTaxData(collective, { isDryRun: options.isDryRun });
    switch (result.status) {
      case 'UPDATED':
        summary.updated++;
        logger.info(
          `Backfilled ${collective.slug} (id: ${collective.id}) from legal document ${result.legalDocumentId} (${result.formType}): ${JSON.stringify(result.updates)}`,
        );
        break;
      case 'WOULD_UPDATE':
        summary.wouldUpdate++;
        logger.info(
          `[DRY RUN] Would backfill ${collective.slug} (id: ${collective.id}) from legal document ${result.legalDocumentId} (${result.formType}): ${JSON.stringify(result.updates)}`,
        );
        break;
      case 'NOTHING_TO_FILL':
        summary.nothingToFill++;
        break;
      case 'NO_USABLE_DOCUMENT':
        summary.noUsableDocument++;
        for (const reason of result.skippedReasons) {
          summary.skippedReasons[reason] = (summary.skippedReasons[reason] || 0) + 1;
        }
        logger.info(
          `Skipped ${collective.slug} (id: ${collective.id}): no usable legal document (${result.skippedReasons.join(', ') || 'none'})`,
        );
        break;
    }
  }

  return summary;
};

const program = new Command();

program.option('--limit <number>', 'Limit the number of accounts to process', parseInt);
program.option('--slug <string>', 'Only process this account slug');

program.action(async options => {
  logger.info(`Running tax data backfill in ${DRY_RUN ? 'DRY RUN' : 'REAL RUN'} mode`);
  const summary = await main({ ...options, isDryRun: DRY_RUN });
  logger.info(`Summary: ${JSON.stringify(summary)}`);
});

if (require.main === module) {
  program
    .parseAsync()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      logger.error(e.toString());
      process.exit(1);
    });
}
