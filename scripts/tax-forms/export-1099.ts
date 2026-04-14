/**
 * This script produces the yearly export that fiscal hosts send to their accountants.
 * It outputs a `{year}-{host}-tax-forms.zip` file structured as follows:
 * - `recipients.csv`: list of all recipients with their details
 * - `files/`: directory containing all the tax forms
 *
 * /!\ The tax form system was internalized in 2024. We should ideally move this script
 * [to an action to the host dashboard](https://github.com/opencollective/opencollective/issues/7374))
 * to account for these changes. See https://github.com/opencollective/opencollective/issues/7216.
 */

import '../../server/env';

import fs from 'fs';
import path from 'path';

import { Parser } from '@json2csv/plainjs';
import { Command } from 'commander';
import { isEmpty, omitBy, truncate } from 'lodash';
import markdownTable from 'markdown-table';
import { QueryTypes } from 'sequelize';

import { US_TAX_FORM_THRESHOLD_POST_2026, US_TAX_FORM_THRESHOLD_PRE_2026 } from '../../server/constants/tax-form';
import logger from '../../server/lib/logger';
import { getFormFieldsFromHelloWorksInstance } from '../../server/lib/tax-forms/helloworks';
import { getStandardizedDataFromOCLegalDocumentData } from '../../server/lib/tax-forms/opencollective';
import { TaxFormCSVColumns, TaxFormCSVRow } from '../../server/lib/tax-forms/types';
import { formatCurrency } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';
import LegalDocument, { LEGAL_DOCUMENT_SERVICE } from '../../server/models/LegalDocument';

const taxFormsQuery = `
  -- Get tax forms
  WITH tax_form_status AS (
    SELECT
      account.id AS "accountId",
      account.slug,
      account.name,
      account."legalName",
      account.type,
      d."documentType" as "requiredDocument",
      MAX(ld."id") AS id,
      MAX(ld."createdAt") AS requested_at,
      MAX(ld."service") AS service,
      MAX(ld."requestStatus") as "legalDocRequestStatus",
      MAX(ld."documentLink") AS "documentLink",
      MAX(ld."data"::varchar) AS "data",
      ABS(SUM(t."amountInHostCurrency")) AS total
    FROM "Collectives" account
    INNER JOIN "Expenses" all_expenses
      ON all_expenses."FromCollectiveId" = account.id
    INNER JOIN "Collectives" c
      ON all_expenses."CollectiveId" = c.id
    INNER JOIN "RequiredLegalDocuments" d
      ON d."HostCollectiveId" = all_expenses."HostCollectiveId"
      AND d."documentType" = 'US_TAX_FORM'
    INNER JOIN "Collectives" host
      ON all_expenses."HostCollectiveId" = host.id
    LEFT JOIN (
      SELECT
        *,
        -- Rank documents by putting RECEIVED first, then by date DESC
        ROW_NUMBER() OVER(
          PARTITION BY "CollectiveId"
          ORDER BY CASE WHEN "requestStatus" = 'RECEIVED' THEN 1 ELSE 2 END ASC, "createdAt" DESC
        ) AS rank
      FROM "LegalDocuments"
      WHERE "deletedAt" IS NULL
      AND "documentType" = 'US_TAX_FORM'
    ) ld ON ld."CollectiveId" = account.id AND ld.rank = 1
    INNER JOIN "Transactions" t
      ON t."ExpenseId" = all_expenses.id
      AND t.type = 'DEBIT'
      AND t.kind = 'EXPENSE'
      AND t."RefundTransactionId" is NULL
      AND t."deletedAt" IS NULL
    LEFT JOIN "PayoutMethods" pm
      ON all_expenses."PayoutMethodId" = pm.id
    WHERE all_expenses.type NOT IN ('RECEIPT', 'CHARGE', 'SETTLEMENT', 'FUNDING_REQUEST', 'GRANT', 'PLATFORM_BILLING')
    AND host.slug = :hostSlug
    AND account.id != d."HostCollectiveId"
    AND (account."HostCollectiveId" IS NULL OR account."HostCollectiveId" != d."HostCollectiveId")
    AND all_expenses.status = 'PAID'
    AND all_expenses."deletedAt" IS NULL
    AND EXTRACT('year' FROM t."createdAt") = :year
    AND pm."type" != 'PAYPAL' AND pm."type" != 'ACCOUNT_BALANCE'
    GROUP BY account.id, d."documentType"
    HAVING ABS(SUM(t."amountInHostCurrency")) >= :threshold
  ) SELECT
    c.name,
    c."legalName",
    ('https://opencollective.com/' || c.slug) AS "profileUrl",
    c."type",
    c."countryISO" as country,
    MIN(tax_form_status."requested_at") AS requested_at,
    MAX(tax_form_status."id") AS "document_id",
    MAX(tax_form_status."data") AS "data",
    MAX(tax_form_status."service") AS "service",
    coalesce(MAX(tax_form_status.total), 0) AS paid,
    REPLACE(MAX(tax_form_status."documentLink"), 'https://opencollective-production-us-tax-forms.s3.us-west-1.amazonaws.com/', '') AS "documentPath",
    string_agg(DISTINCT u.email, ', ') AS "adminEmails"
  FROM tax_form_status
  -- Add collective admins
  INNER JOIN "Collectives" c ON tax_form_status."accountId" = c.id
  LEFT JOIN "Members" m ON m."CollectiveId" = c.id AND m."role" = 'ADMIN'
  INNER JOIN "Users" u ON u."CollectiveId" = c.id OR u."CollectiveId" = m."MemberCollectiveId"
  GROUP BY c.id, tax_form_status."accountId"
  ORDER BY c."name"
`;

type Recipient = {
  name: string;
  service: string;
  legalName: string;
  profileUrl: string;
  type: string;
  country: string;
  adminEmails: string;
  documentPath: string;
  paid: number;
  data: string;
};

/**
 * A small helper to convert the path to the format produced by https://github.com/opencollective/encrypt_dir/blob/f038ffc8d53d679f9edbd1b1131de484be99e81f/decryptDir.js
 * @param basePath The base path without the S3 domain
 */
const prepareDocumentPath = (basePath: string) => {
  if (!basePath) {
    return '';
  } else if (basePath.startsWith('https://')) {
    return basePath; // Do nothing for Drive links
  }

  if (!basePath.match(/US_TAX_FORM\/\d{4}\/.+/)) {
    // Get year from basePath (US_TAX_FORM_2020_xxx.pdf)
    const year = basePath.match(/US_TAX[ _]FORM_(\d{4})/i)[1];
    const pathWithoutYear = basePath.replace(/US_TAX[ _]FORM_\d{4}_/i, '');
    basePath = path.join('US_TAX_FORM', year, pathWithoutYear);
  }

  // Finish by running decodeURIComponent on the filename
  const filename = decodeURIComponent(path.basename(basePath));
  return path.join(path.dirname(basePath), filename);
};

const parseCommandLine = () => {
  const program = new Command();
  program.showSuggestionAfterError();
  program.arguments('<year>');
  program.option('--hostSlugs <hostSlugs>', 'Comma-separated list of host slugs');
  program.option('--files-dir <path>', 'Directory where the tax forms are stored');
  program.option('--output-dir <path>', 'Directory where the output files will be stored');
  program.parse();

  const options = program.opts();
  if (!options.outputDir) {
    console.warn(
      'Output directory (--output-dir) not specified, the script will only summarize the results in the console',
    );
  }

  return { year: parseInt(program.args[0]), options };
};

// Setting the `fields` argument to enforce columns order
const generateCSVFromData = data => new Parser({ header: true, fields: Object.values(TaxFormCSVColumns) }).parse(data);

const parseCountryFromHelloWorks = (country: string | undefined) => {
  if (!country) {
    return '';
  } else if (country.length === 2) {
    return country;
  } else {
    // HelloWorks instances are aimed to be removed, so we only hardcode the ones we need
    return (
      {
        ukraine: 'UA',
        pakistan: 'PK',
        nigeria: 'NG',
        japan: 'JP',
        india: 'IN',
        china: 'CN',
        netherlands: 'NL',
        'united arab emirates': 'AE',
        france: 'FR',
        deutschland: 'DE',
        australia: 'AU',
        'united states': 'US',
        poland: 'PL',
        philippines: 'PH',
        spain: 'ES',
        'south africa': 'ZA',
        canada: 'CA',
        'the netherlands': 'NL',
        russia: 'RU',
        'sri lanka': 'LK',
        ireland: 'IE',
        indonesia: 'ID',
        bangladesh: 'BD',
        hungary: 'HU',
        undefined: '',
        finland: 'FI',
        'united kingdom': 'GB',
        portugal: 'PT',
        denmark: 'DK',
        'wales, united kingdom': 'GB',
        belgium: 'BE',
        germany: 'DE',
        brazil: 'BR',
        austria: 'AT',
        italy: 'IT',
        singapore: 'SG',
        norway: 'NO',
        tanzania: 'TZ',
        kazakhstan: 'KZ',
      }[country.toLowerCase()] || country
    );
  }
};

export const generateExport = async (
  hostSlug: string,
  year: number | string,
  recipients: Recipient[],
  { outputDir = null, filesDir = null, initialWarnings = [] },
) => {
  const warnings: string[] = [...initialWarnings];
  const preparedData: TaxFormCSVRow[] = [];
  for (const recipient of recipients) {
    const data = JSON.parse(recipient.data);

    // Some HelloWorks files have been manually imported as "OPENCOLLECTIVE". We'll get rid of this logic when all dropbox forms will have expired, around 2028
    if (recipient.service === LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS || data?.helloWorks?.instance) {
      const formData = getFormFieldsFromHelloWorksInstance(data);
      preparedData.push({
        [TaxFormCSVColumns.RECIPIENT_NAME]: formData.participantName || recipient.legalName || recipient.name,
        [TaxFormCSVColumns.ACCOUNT]: recipient.profileUrl,
        [TaxFormCSVColumns.TYPE]: formData.type,
        [TaxFormCSVColumns.ENTITY]: formData.entityName,
        [TaxFormCSVColumns.STATUS]: formData.status,
        [TaxFormCSVColumns.TAX_ID_TYPE]: formData.taxIdNumberType,
        [TaxFormCSVColumns.TAX_ID]: formData.taxIdNumber,
        [TaxFormCSVColumns.RECIPIENT_ADDRESS_1]: formData.address1,
        [TaxFormCSVColumns.RECIPIENT_ADDRESS_2]: formData.address2,
        [TaxFormCSVColumns.RECIPIENT_COUNTRY]: parseCountryFromHelloWorks(formData.country),
        [TaxFormCSVColumns.RECIPIENT_EMAIL]: formData.email || recipient.adminEmails,
        [TaxFormCSVColumns.BOX_1_NONEMPLOYEE_COMPENSATION]: formatCurrency(recipient.paid, 'USD'),
        [TaxFormCSVColumns.FILE]: prepareDocumentPath(recipient.documentPath),
        [TaxFormCSVColumns.DROPBOX_FORM_INSTANCE]: formData.instanceId,
        [TaxFormCSVColumns.PLATFORM_ID]: recipient['document_id'],
      });
    } else if (recipient.service === LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE) {
      const baseRow = {
        [TaxFormCSVColumns.RECIPIENT_NAME]: recipient.legalName || recipient.name,
        [TaxFormCSVColumns.ACCOUNT]: recipient.profileUrl,
        [TaxFormCSVColumns.BOX_1_NONEMPLOYEE_COMPENSATION]: formatCurrency(recipient.paid, 'USD'),
        [TaxFormCSVColumns.FILE]: prepareDocumentPath(recipient.documentPath),
        [TaxFormCSVColumns.DROPBOX_FORM_INSTANCE]: null,
        [TaxFormCSVColumns.PLATFORM_ID]: recipient['document_id'],
      };

      const encryptedFormData = data?.encryptedFormData;
      if (encryptedFormData) {
        const formData = JSON.parse(LegalDocument.decrypt(Buffer.from(encryptedFormData, 'base64')).toString()) || {};
        const rowFromFormData = getStandardizedDataFromOCLegalDocumentData(formData);
        preparedData.push({ ...baseRow, ...omitBy(rowFromFormData, isEmpty) });
      } else {
        preparedData.push(baseRow);
      }
    } else {
      const warning = `Unknown service: ${JSON.stringify(recipient)}`;
      console.warn(warning);
      warnings.push(warning);
      preparedData.push({
        [TaxFormCSVColumns.RECIPIENT_NAME]: recipient.legalName || recipient.name,
        [TaxFormCSVColumns.ACCOUNT]: recipient.profileUrl,
        [TaxFormCSVColumns.BOX_1_NONEMPLOYEE_COMPENSATION]: formatCurrency(recipient.paid, 'USD'),
        [TaxFormCSVColumns.RECIPIENT_EMAIL]: recipient.adminEmails,
        [TaxFormCSVColumns.RECIPIENT_COUNTRY]: recipient.country,
      });
    }
  }

  if (!preparedData.length) {
    console.log('No tax forms found');
    return;
  }

  const csv = generateCSVFromData(preparedData);
  if (outputDir) {
    const tmpDir = path.join(outputDir, `${hostSlug}-${year}`);

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Copy all PDFs
    if (!filesDir) {
      const warning = 'Files directory (--files-dir) not specified, the script will not copy the tax forms';
      console.warn(warning);
      warnings.push(warning);
    } else {
      for (const row of preparedData) {
        if (!row.File || !row.File.startsWith('US_TAX_FORM/')) {
          continue;
        }

        const filePath = path.join(filesDir, row.File);
        let actualFilePath = filePath;

        // If file not found at expected path, try fallback to root folder
        if (!fs.existsSync(filePath)) {
          const filename = path.basename(row.File);
          const fallbackPath = path.join(filesDir, filename);
          if (fs.existsSync(fallbackPath)) {
            actualFilePath = fallbackPath;
          } else {
            const warning = `File not found: ${filePath} (also tried fallback: ${fallbackPath})`;
            console.warn(warning);
            warnings.push(warning);
            continue;
          }
        }

        const outputFile = path.join(tmpDir, row.File);
        const fileDir = path.dirname(outputFile);
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true });
        }

        fs.copyFileSync(actualFilePath, outputFile);
      }
    }

    // Generate CSV
    fs.writeFileSync(`${tmpDir}/${hostSlug}-${year}-tax-forms.csv`, csv);

    // Write warnings to file
    if (warnings.length > 0) {
      fs.writeFileSync(path.join(tmpDir, 'warnings.log'), `${warnings.join('\n')}\n`);
    }

    console.log(`Export generated in ${tmpDir}`);
  } else {
    console.log(
      markdownTable([
        Object.keys(preparedData[0]).map(key => truncate(key, { length: 30 })),
        ...preparedData.map(recipient =>
          Object.entries(recipient).map(([key, value]) => {
            if (key === 'File') {
              return value;
            } else {
              return value && truncate(value.toString(), { length: 30 });
            }
          }),
        ),
      ]),
    );
  }
};

const main = async () => {
  const { year, options } = parseCommandLine();
  let hostSlugs: string[] = options.hostSlugs?.split(',');
  if (!hostSlugs) {
    const hostsWithTaxFormSystem = await models.Collective.findAll({
      include: [{ model: models.RequiredLegalDocument, where: { documentType: 'US_TAX_FORM' }, required: true }],
    });
    hostSlugs = hostsWithTaxFormSystem.map(host => host.slug);
  }

  for (const hostSlug of hostSlugs) {
    logger.info(`Exporting tax forms for ${hostSlug} in ${year}`);

    const host = await models.Collective.findBySlug(hostSlug, {
      include: [{ model: models.RequiredLegalDocument, where: { documentType: 'US_TAX_FORM' }, required: false }],
    });

    if (!host) {
      throw new Error(`${hostSlug} not found`);
    } else if (!host.RequiredLegalDocuments.length) {
      throw new Error(`${hostSlug} is not connected to the tax form system`);
    }

    const threshold = year >= 2026 ? US_TAX_FORM_THRESHOLD_POST_2026 : US_TAX_FORM_THRESHOLD_PRE_2026;
    const allRecipients: Recipient[] = await sequelize.query(taxFormsQuery, {
      replacements: { hostSlug, year, threshold },
      type: QueryTypes.SELECT,
    });

    const pendingRecipients = allRecipients.filter(recipient => recipient['document_id'] === null);
    const initialWarnings: string[] = [];
    if (pendingRecipients.length) {
      const warning = `${pendingRecipients.length} tax forms are still pending for ${hostSlug}`;
      logger.warn(warning);
      initialWarnings.push(warning);
    }

    console.log(`Found ${allRecipients.length} tax forms for ${hostSlug}`);

    await generateExport(hostSlug, year, allRecipients, { ...options, initialWarnings });
  }
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
