import { expect } from 'chai';

import {
  backfillAccountTaxData,
  deriveTaxDataFromLegalDocument,
  main as runBackfill,
} from '../../../scripts/fixes/backfill-taxable-country-from-legal-documents';
import models from '../../../server/models';
import { LEGAL_DOCUMENT_REQUEST_STATUS, LEGAL_DOCUMENT_SERVICE } from '../../../server/models/LegalDocument';
import { fakeCollective, fakeLegalDocument, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const { LegalDocument } = models;

const YEAR = new Date().getFullYear();

const encryptFormData = (formData: Record<string, unknown>): string => {
  return LegalDocument.encrypt(Buffer.from(JSON.stringify(formData))).toString('base64');
};

const createSubmittedDocument = async (
  collective,
  {
    year = YEAR,
    formData,
    service = LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
    requestStatus = LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
    data = {},
  }: {
    year?: number;
    formData?: Record<string, unknown>;
    service?: LEGAL_DOCUMENT_SERVICE;
    requestStatus?: LEGAL_DOCUMENT_REQUEST_STATUS;
    data?: Record<string, unknown>;
  } = {},
) => {
  return fakeLegalDocument({
    CollectiveId: collective.id,
    year,
    requestStatus,
    service,
    data: {
      ...data,
      ...(formData ? { encryptedFormData: encryptFormData(formData) } : {}),
    },
  });
};

describe('scripts/fixes/backfill-taxable-country-from-legal-documents', () => {
  beforeEach(resetTestDB);

  describe('deriveTaxDataFromLegalDocument', () => {
    it('derives the country and US-entity status from a W9', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective, {
        formData: { formType: 'W9', location: { country: 'US' } },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'DERIVED',
        formType: 'W9',
        taxableCountry: 'US',
        isUSEntity: true,
      });
    });

    it('derives the residence country and non-US status from a W8_BEN', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective, {
        formData: { formType: 'W8_BEN', residenceAddress: { country: 'FR' } },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'DERIVED',
        formType: 'W8_BEN',
        taxableCountry: 'FR',
        isUSEntity: false,
      });
    });

    it('derives the incorporation country from a W8_BEN_E', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective, {
        formData: { formType: 'W8_BEN_E', businessCountryOfIncorporationOrOrganization: 'CA' },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'DERIVED',
        formType: 'W8_BEN_E',
        taxableCountry: 'CA',
        isUSEntity: false,
      });
    });

    it('falls back to the business address country for a W8_BEN_E without incorporation country', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective, {
        formData: { formType: 'W8_BEN_E', businessAddress: { country: 'DE' } },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'DERIVED',
        formType: 'W8_BEN_E',
        taxableCountry: 'DE',
        isUSEntity: false,
      });
    });

    it('uses the explicit isUSPersonOrEntity answer over the form type', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective, {
        formData: { formType: 'W9', isUSPersonOrEntity: false, location: { country: 'US' } },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'DERIVED',
        formType: 'W9',
        taxableCountry: 'US',
        isUSEntity: false,
      });
    });

    it('skips manually uploaded documents', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective, {
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        data: { isManual: true },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'SKIPPED',
        reason: 'MANUAL_UPLOAD',
      });
    });

    it('skips legacy HelloWorks/Dropbox Forms documents', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective, {
        service: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS,
        data: { helloWorks: { instance: { id: 'instance-id' } } },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'SKIPPED',
        reason: 'LEGACY_HELLOWORKS',
      });
    });

    it('skips received documents without an encrypted payload', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective);

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'SKIPPED',
        reason: 'NO_ENCRYPTED_FORM_DATA',
      });
    });

    it('skips undecryptable payloads without throwing', async () => {
      const collective = await fakeCollective();
      const legalDocument = await fakeLegalDocument({
        CollectiveId: collective.id,
        year: YEAR,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        data: { encryptedFormData: 'not-a-valid-payload' },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'SKIPPED',
        reason: 'UNDECRYPTABLE_PAYLOAD',
      });
    });

    it('skips payloads from which nothing can be derived', async () => {
      const collective = await fakeCollective();
      const legalDocument = await createSubmittedDocument(collective, {
        formData: { formType: 'UNKNOWN' },
      });

      expect(deriveTaxDataFromLegalDocument(legalDocument)).to.deep.equal({
        status: 'SKIPPED',
        reason: 'NO_DERIVABLE_VALUE',
      });
    });
  });

  describe('backfillAccountTaxData', () => {
    it('fills both missing fields and preserves other account data', async () => {
      const collective = await fakeCollective({ data: { privateInstructions: 'note' } });
      await createSubmittedDocument(collective, {
        formData: { formType: 'W9', location: { country: 'US' } },
      });

      const result = await backfillAccountTaxData(collective, { isDryRun: false });

      expect(result.status).to.equal('UPDATED');
      await collective.reload();
      expect(collective.data?.taxableCountry).to.equal('US');
      expect(collective.data?.isUSEntity).to.equal(true);
      expect(collective.data?.privateInstructions).to.equal('note');
    });

    it('only fills the missing field and never overwrites an existing one', async () => {
      const collective = await fakeCollective({ data: { taxableCountry: 'US' } });
      await createSubmittedDocument(collective, {
        formData: { formType: 'W8_BEN', residenceAddress: { country: 'FR' } },
      });

      const result = await backfillAccountTaxData(collective, { isDryRun: false });

      expect(result).to.deep.include({ status: 'UPDATED', updates: { isUSEntity: false } });
      await collective.reload();
      expect(collective.data?.taxableCountry).to.equal('US');
      expect(collective.data?.isUSEntity).to.equal(false);
    });

    it('does nothing when both fields are already set', async () => {
      const collective = await fakeCollective({ data: { taxableCountry: 'US', isUSEntity: true } });
      await createSubmittedDocument(collective, {
        formData: { formType: 'W8_BEN', residenceAddress: { country: 'FR' } },
      });

      const result = await backfillAccountTaxData(collective, { isDryRun: false });

      expect(result.status).to.equal('NOTHING_TO_FILL');
      await collective.reload();
      expect(collective.data?.taxableCountry).to.equal('US');
      expect(collective.data?.isUSEntity).to.equal(true);
    });

    it('uses the most recent received document', async () => {
      const collective = await fakeCollective();
      await createSubmittedDocument(collective, {
        year: YEAR - 1,
        formData: { formType: 'W8_BEN', residenceAddress: { country: 'FR' } },
      });
      await createSubmittedDocument(collective, {
        year: YEAR,
        formData: { formType: 'W9', location: { country: 'US' } },
      });

      await backfillAccountTaxData(collective, { isDryRun: false });

      await collective.reload();
      expect(collective.data?.taxableCountry).to.equal('US');
      expect(collective.data?.isUSEntity).to.equal(true);
    });

    it('prefers the most recently submitted document over a higher tax year', async () => {
      const collective = await fakeCollective();
      await createSubmittedDocument(collective, {
        year: YEAR,
        formData: { formType: 'W9', location: { country: 'US' } },
      });
      // A later submission recorded for a prior tax year must win over an earlier one.
      await createSubmittedDocument(collective, {
        year: YEAR - 1,
        formData: { formType: 'W8_BEN', residenceAddress: { country: 'FR' } },
      });

      await backfillAccountTaxData(collective, { isDryRun: false });

      await collective.reload();
      expect(collective.data?.taxableCountry).to.equal('FR');
      expect(collective.data?.isUSEntity).to.equal(false);
    });

    it('ignores invalidated documents and never resurrects their values', async () => {
      const collective = await fakeCollective();
      await createSubmittedDocument(collective, {
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.INVALID,
        formData: { formType: 'W9', location: { country: 'US' } },
      });

      const result = await backfillAccountTaxData(collective, { isDryRun: false });

      expect(result.status).to.equal('NO_USABLE_DOCUMENT');
      await collective.reload();
      expect(collective.data?.taxableCountry).to.be.undefined;
      expect(collective.data?.isUSEntity).to.be.undefined;
    });

    it('falls back to an older usable document when the most recent one is a manual upload', async () => {
      const collective = await fakeCollective();
      await createSubmittedDocument(collective, {
        year: YEAR - 1,
        formData: { formType: 'W8_BEN', residenceAddress: { country: 'FR' } },
      });
      await createSubmittedDocument(collective, {
        year: YEAR,
        data: { isManual: true },
      });

      await backfillAccountTaxData(collective, { isDryRun: false });

      await collective.reload();
      expect(collective.data?.taxableCountry).to.equal('FR');
      expect(collective.data?.isUSEntity).to.equal(false);
    });

    it('does not write anything in dry run mode', async () => {
      const collective = await fakeCollective();
      await createSubmittedDocument(collective, {
        formData: { formType: 'W9', location: { country: 'US' } },
      });

      const result = await backfillAccountTaxData(collective, { isDryRun: true });

      expect(result).to.deep.include({
        status: 'WOULD_UPDATE',
        updates: { taxableCountry: 'US', isUSEntity: true },
      });
      await collective.reload();
      expect(collective.data?.taxableCountry).to.be.undefined;
      expect(collective.data?.isUSEntity).to.be.undefined;
    });

    it('is idempotent', async () => {
      const collective = await fakeCollective();
      await createSubmittedDocument(collective, {
        formData: { formType: 'W9', location: { country: 'US' } },
      });

      await backfillAccountTaxData(collective, { isDryRun: false });
      const secondRun = await backfillAccountTaxData(collective, { isDryRun: false });

      expect(secondRun.status).to.equal('NOTHING_TO_FILL');
    });

    it('works for individual accounts', async () => {
      const user = await fakeUser();
      await createSubmittedDocument(user.collective, {
        formData: { formType: 'W8_BEN', residenceAddress: { country: 'BE' } },
      });

      await backfillAccountTaxData(user.collective, { isDryRun: false });

      await user.collective.reload();
      expect(user.collective.data?.taxableCountry).to.equal('BE');
      expect(user.collective.data?.isUSEntity).to.equal(false);
    });
  });

  describe('main', () => {
    it('backfills only the accounts that are missing data and have a usable document', async () => {
      const missingDataCollective = await fakeCollective({ data: { privateInstructions: 'keep-me' } });
      await createSubmittedDocument(missingDataCollective, {
        formData: { formType: 'W9', location: { country: 'US' } },
      });

      const alreadySetCollective = await fakeCollective({ data: { taxableCountry: 'FR', isUSEntity: false } });
      await createSubmittedDocument(alreadySetCollective, {
        formData: { formType: 'W9', location: { country: 'US' } },
      });

      const noDocumentCollective = await fakeCollective();

      const summary = await runBackfill({ isDryRun: false });

      expect(summary.scanned).to.equal(1);
      expect(summary.updated).to.equal(1);

      await missingDataCollective.reload();
      expect(missingDataCollective.data?.taxableCountry).to.equal('US');
      expect(missingDataCollective.data?.isUSEntity).to.equal(true);
      expect(missingDataCollective.data?.privateInstructions).to.equal('keep-me');

      await alreadySetCollective.reload();
      expect(alreadySetCollective.data?.taxableCountry).to.equal('FR');
      expect(alreadySetCollective.data?.isUSEntity).to.equal(false);

      await noDocumentCollective.reload();
      expect(noDocumentCollective.data?.taxableCountry).to.be.undefined;
    });

    it('reports skipped accounts with their reasons and writes nothing in dry run mode', async () => {
      const manualOnlyCollective = await fakeCollective();
      await createSubmittedDocument(manualOnlyCollective, { data: { isManual: true } });

      const legacyOnlyCollective = await fakeCollective();
      await createSubmittedDocument(legacyOnlyCollective, {
        service: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS,
        data: { helloWorks: { instance: {} } },
      });

      const summary = await runBackfill({ isDryRun: true, slug: manualOnlyCollective.slug });

      expect(summary.scanned).to.equal(1);
      expect(summary.wouldUpdate).to.equal(0);
      expect(summary.noUsableDocument).to.equal(1);
      expect(summary.skippedReasons).to.deep.equal({ MANUAL_UPLOAD: 1 });

      await manualOnlyCollective.reload();
      expect(manualOnlyCollective.data?.taxableCountry).to.be.undefined;

      const legacySummary = await runBackfill({ isDryRun: true, slug: legacyOnlyCollective.slug });
      expect(legacySummary.skippedReasons).to.deep.equal({ LEGACY_HELLOWORKS: 1 });
    });
  });
});
