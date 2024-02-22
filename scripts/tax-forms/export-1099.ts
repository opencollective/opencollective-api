/**
 * This script produces the yearly export that fiscal hosts send to their accountants.
 * It outputs a `{year}-{host}-tax-forms.zip` file structured as follows:
 * - `recipients.csv`: list of all recipients with their details
 * - `files/`: directory containing all the tax forms
 */

import '../../server/env';

import fs from 'fs';
import path from 'path';

import { Parser } from '@json2csv/plainjs';
import { Command } from 'commander';
import { get, truncate } from 'lodash';
import markdownTable from 'markdown-table'; // eslint-disable-line node/no-unpublished-import

import {
  fetchHelloWorksInstance,
  getFormFieldsFromHelloWorksInstance,
  HelloWorksTaxFormInstance,
} from '../../server/controllers/helloworks';
import { formatCurrency } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';

const json2csv = (data, opts = undefined) => new Parser(opts).parse(data);

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
      MAX(ld."createdAt") AS requested_at,
      MAX(ld."requestStatus") as "legalDocRequestStatus",
      MAX(ld."documentLink") AS "documentLink",
      MAX(ld."data"::varchar) AS "data",
      ABS(
        SUM(t."amountInHostCurrency" * (
          CASE
            WHEN all_expenses."currency" = host.currency THEN 1
            ELSE (
              SELECT COALESCE("rate", 1)
              FROM "CurrencyExchangeRates" er
              WHERE er."from" = all_expenses."currency"
              AND er."to" = host.currency
              AND er."createdAt" < all_expenses."createdAt"
              ORDER BY "createdAt" DESC
              LIMIT 1
            )
          END
        ))
      ) AS total
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
      AND year + 3 >= :year
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
    WHERE all_expenses.type NOT IN ('RECEIPT', 'CHARGE', 'SETTLEMENT', 'FUNDING_REQUEST', 'GRANT')
    AND host.slug = :hostSlug
    AND account.id != d."HostCollectiveId"
    AND (account."HostCollectiveId" IS NULL OR account."HostCollectiveId" != d."HostCollectiveId")
    AND all_expenses.status = 'PAID'
    AND all_expenses."deletedAt" IS NULL
    AND EXTRACT('year' FROM t."createdAt") = :year
    AND pm."type" != 'PAYPAL' AND pm."type" != 'ACCOUNT_BALANCE'
    GROUP BY account.id, d."documentType"
    HAVING COALESCE(SUM(all_expenses."amount"), 0) >= 60000
  ) SELECT
    c.name,
    c."legalName",
    ('https://opencollective.com/' || c.slug) AS "profileUrl",
    c."type",
    c."countryISO" as country,
    MIN(tax_form_status."requested_at") AS requested_at,
    MAX(tax_form_status."data") AS "data",
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
  program.arguments('<year> <hostSlug>');
  program.option('--files-dir <path>', 'Directory where the tax forms are stored');
  program.option('--output-dir <path>', 'Directory where the output files will be stored');
  program.option('--cache-dir <path>', 'Directory where the cache files (the responses from HelloWorks) are stored');
  program.parse();

  const options = program.opts();
  if (!options.outputDir) {
    console.warn(
      'Output directory (--output-dir) not specified, the script will only summarize the results in the console',
    );
  }
  if (!options.cacheDir) {
    console.warn(
      'Cache directory (--cache-dir) not specified, the script will be slower as it will have to fetch the HelloWorks responses again',
    );
  }

  return { year: program.args[0], hostSlug: program.args[1], options };
};

const getHelloWorksInstance = async (instanceId: string, cacheDir): Promise<HelloWorksTaxFormInstance> => {
  if (!instanceId) {
    return null;
  }

  // Try to return from cache
  if (cacheDir) {
    const cachePath = path.join(cacheDir, `${instanceId}.json`);
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    }
  }

  // Otherwise fetch from HelloWorks
  const instance = await fetchHelloWorksInstance(instanceId);
  if (instance && cacheDir) {
    fs.writeFileSync(path.join(cacheDir, `${instanceId}.json`), JSON.stringify(instance));
  }

  return instance;
};

const generateExport = async (
  hostSlug: string,
  year: number | string,
  recipients,
  { outputDir = null, filesDir = null, cacheDir = null },
) => {
  const preparedData = [];
  for (const recipient of recipients) {
    const data = JSON.parse(recipient.data);
    const helloWorksInstance = await getHelloWorksInstance(get(data, 'helloWorks.instance.id'), cacheDir);
    const formData = getFormFieldsFromHelloWorksInstance(helloWorksInstance);
    preparedData.push({
      "Recipient's Name": formData.participantName || recipient.legalName || recipient.name,
      Account: recipient.profileUrl,
      Type: formData.type,
      Entity: formData.entityName,
      Status: formData.status,
      'Tax ID Type': formData.taxIdNumberType,
      'Tax ID': formData.taxIdNumber,
      'Recipient Address (1)': formData.address1,
      'Recipient Address (2)': formData.address2,
      'Recipient Country': formData.country,
      'Recipient Email': formData.email || helloWorksInstance?.metadata?.email || recipient.adminEmails,
      'Box 1 Nonemployee Compensation': formatCurrency(recipient.paid, 'USD'),
      File: prepareDocumentPath(recipient.documentPath),
      'Dropbox Form Instance': get(data, 'helloWorks.instance.id'),
    });
  }

  const csv = json2csv(preparedData, { header: true });
  if (outputDir) {
    const tmpDir = path.join(outputDir, `${hostSlug}-${year}`);

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Copy all PDFs
    if (!filesDir) {
      console.warn('Files directory (--files-dir) not specified, the script will not copy the tax forms');
    } else {
      for (const row of preparedData) {
        if (!row.File || !row.File.startsWith('US_TAX_FORM/')) {
          continue;
        }

        const filePath = path.join(filesDir, row.File);
        if (fs.existsSync(filePath)) {
          const outputFile = path.join(tmpDir, row.File);
          const fileDir = path.dirname(outputFile);
          if (!fs.existsSync(fileDir)) {
            fs.mkdirSync(fileDir, { recursive: true });
          }

          fs.copyFileSync(filePath, outputFile);
        } else {
          console.warn(`File not found: ${filePath}`);
        }
      }
    }

    // Generate CSV
    fs.writeFileSync(`${tmpDir}/${hostSlug}-${year}-tax-forms.csv`, csv);

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
  const { year, hostSlug, options } = parseCommandLine();
  const host = await models.Collective.findBySlug(hostSlug, {
    include: [{ model: models.RequiredLegalDocument, where: { documentType: 'US_TAX_FORM' }, required: false }],
  });

  if (!host) {
    throw new Error(`${hostSlug} not found`);
  } else if (!host.RequiredLegalDocuments.length) {
    throw new Error(`${hostSlug} is not connected to the tax form system`);
  }

  const recipients = await sequelize.query(taxFormsQuery, {
    replacements: { hostSlug, year },
    type: sequelize.QueryTypes.SELECT,
  });

  await generateExport(hostSlug, year, recipients, options);
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
