/**
 * This script produces the yearly export that fiscal hosts send to their accountants.
 * It outputs a `{year}-{host}-tax-forms.zip` file structured as follows:
 * - `recipients.csv`: list of all recipients with their details
 * - `files/`: directory containing all the tax forms
 *
 * /!\ The tax form system was internalized in 2024. We'll need to update this script (or move
 * it [as an action to the host dashboard](https://github.com/opencollective/opencollective/issues/7374))
 * to account for these changes. See https://github.com/opencollective/opencollective/issues/7216.
 */

import '../../server/env';

import fs from 'fs';
import path from 'path';

import { Parser } from '@json2csv/plainjs';
import { Command } from 'commander';
import { get, truncate } from 'lodash';
import markdownTable from 'markdown-table'; // eslint-disable-line n/no-unpublished-import

import { formatCurrency } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';
import LegalDocument, { LEGAL_DOCUMENT_SERVICE, USTaxFormType } from '../../server/models/LegalDocument';

const json2csv = (data, opts = undefined) => new Parser(opts).parse(data);

type HelloWorksTaxFormInstance = {
  audit_trail_hash: string;
  id: string;
  metadata: {
    accountId: string;
    accountType: string;
    adminEmails: string;
    email: string;
    userId: string;
    year: string;
  };
  status: string;
  workflow_id: string;
  document_hashes: Record<string, string>;
  mode: string;
  type: string;
  data: {
    // Latest version of the form
    Form_nRZrdh?: {
      /** Name of organization that is the beneficial owner */
      field_3HxExU: string;
      /** Chapter 3 Status (entity type) */
      field_7h9cxX: string;
      field_96QX5j: string;
      /** Are you US Person or Entity? */
      field_ENxHCd: 'Yes' | 'No';
      field_FTZIWD: string;
      field_G7YfJr: string;
      field_OSOk14: string;
      /** Permanent residence address */
      field_T0IdZf: string;
      /** Country of incorporation or organization */
      field_VvICe1: string;
      /** Your_Email (Participant) */
      field_gwd8pa: string;
      /** Foreign TIN */
      field_hJkq4B: string;
      /** Name of disregarded entity receiving the payment */
      field_F1U7HL: string;
      field_hWAMyS: string;
      /** Name of the signer */
      field_mqVUrj: string;
      /** Mailing address */
      field_pITmtq: string;
      /** Are you submitting as... */
      field_xdp45L: 'an individual person' | 'a business or entity';
      /** Signature date */
      field_5yf9Bp: string;
      /** Foreign tax identifying number */
      field_JiKEj4: string;
      /** Certify country of residence */
      field_SZJNur: string;
      field_XdGK3o: string;
      /** Signer name */
      field_Xdy5Kk: string;
      // -----
      /** Signer name */
      field_JI6gsq: string;
      /** Enter_SSN (Participant) */
      field_SXcrBL: string;
      /** Address_(city,_state,_ZIP) (Participant) */
      field_bsHU5V: string;
      /** Tax ID number type */
      field_m4nLix: 'SSN' | 'EIN';
      field_oU5IRt: string;
      field_pxvAbW: string;
      /** Business type */
      field_ruhFN4:
        | 'Individual (or sole proprietor)'
        | 'C-Corp'
        | 'S-Corp'
        | 'Partnership'
        | 'Trust/Estate'
        | 'LLC'
        | 'Other (specify at the end of this form)';
      /** You selected "other tax classification" — please specify: */
      field_IYb1zy: string;
      // ----  US person/entity fields (field_ENxHCd=true) ----
      /** Name (Participant) */
      field_vBxRqQ: string;
      /** Address_(number,_street,_apt) (Participant) */
      field_y19HZi: string;
      /** Optional:_Exempt_payee_code_(if_any) (Participant) */
      field_tOgTam: string;
      /** Enter_EIN (Participant) */
      field_nsaxM8: string;
      /** U.S._SSN_or_ITIN_(if_required) (Participant) */
      field_iGedCY: string;
      // ---- W8-BEN (individuals) ----
      /** Permanent residence address (street, apt. or suite no., or rural route) */
      field_AdoY67: string;
      /** Country of citizenship */
      field_dIEvL2: string;
      /** Name of individual who is the beneficial owner */
      field_3IvuYi: string;
      field_26SpJI: string;
      field_2BzOcB: string;
      field_2o6n1d: string;
      /** Postal_address (Participant) */
      field_3j4IQT: string;
      /** Country of residence */
      field_e2uMPk: string;
    };
    // Legacy version of the form
    Form_jmV4rR?: {
      /** Participant name */
      field_nTuM3q: string;
      /** Date of birth  */
      field_5zvlrH: string;
      /** Name of individual that is the beneficial owner */
      field_7G0PTT: string;
      /** Do you claim tax treaty benefits for chapter 3 purposes? */
      field_8JIBUU: string;
      /** Signer name */
      field_HEJfi8: string;
      /** Are you US Person or Entity? */
      field_Jj5lq3: 'Yes' | 'No';
      /** Email */
      field_LEHARZ: string;
      /** Foreign tax identifying number */
      field_TDttcV: string;
      /** Mailing address */
      field_UXEERA: string;
      /** Country of citizenship */
      field_VjJblP: string;
      /** Are you submitting as... */
      field_W7cOxA: 'an individual person' | 'a business or entity';
      /** Has confirmed info */
      field_XKL6pp: 'Yes' | 'No';
      /** Signature date */
      field_kIEVyL: string;
      /** Permanent residence address */
      field_nhEGv2: string;
      // Conditional fields
      field_6qJvKv: string;
      /** Signature date */
      field_LCxCSj: string;
      /** Tax ID number type */
      field_GP1WVV: 'SSN' | 'EIN';
      /** SSN */
      field_IHousr: string;
      /** EIN */
      field_U1SIy7: string;
      /** US tax ID number */
      field_YBBuNx: string;
      /** Foreign tax identifying number */
      field_NwJcK9: string;
      /** You selected "other tax classification" — please specify: */
      field_uRwOOO: string;
      /** Name */
      field_Q3j60N: string;
      field_WHuufi: string;
      /** Permanent residence address (street, apt. or suite no., or rural route). */
      field_Zdjn7X: string;
      /** Certify that is not a financial institution */
      field_fAve48: 'Yes' | 'No';
      /** Name of organization that is the beneficial owner */
      field_pLPdKR: string;
      field_qXoH7X: string;
      /** Chapter 3 status */
      field_qgGMt1: string;
      /** Country of incorporation or organization */
      field_ro87Pn: string;
      /** Address_(number,_street,_apt) (Participant) */
      field_nSSZij: string;
      /** Address_(city,_state,_ZIP) (Participant) */
      field_2A7YUM: string;
      /** Business name */
      field_TDe8mH: string;
      /** Business type */
      field_TDyswI:
        | 'Individual (or sole proprietor)'
        | 'C-Corp'
        | 'S-Corp'
        | 'Partnership'
        | 'Trust/Estate'
        | 'LLC'
        | 'Other (specify at the end of this form)';
    };
  };
};

type HelloWorksFormFields = {
  type?: USTaxFormType;
  participantName?: string;
  entityName?: string;
  address1?: string;
  address2?: string;
  taxIdNumberType?: string;
  taxIdNumber?: string;
  country?: string;
  email?: string;
  status?: string;
};

const getFormFieldsFromHelloWorksInstance = (instance: HelloWorksTaxFormInstance | null): HelloWorksFormFields => {
  if (!instance?.data) {
    return {};
  } else if (instance.data.Form_nRZrdh) {
    const data = instance.data.Form_nRZrdh;
    const participantName = data.field_JI6gsq || data.field_mqVUrj || data.field_Xdy5Kk || data.field_3HxExU;
    const entityName = data.field_3HxExU || data.field_vBxRqQ || data.field_3IvuYi || data.field_F1U7HL;
    return {
      // Participant name == signer name
      type:
        data.field_ENxHCd === 'Yes'
          ? 'W9'
          : data.field_xdp45L === 'a business or entity'
            ? 'W8_BEN_E'
            : data.field_xdp45L === 'an individual person'
              ? 'W8_BEN'
              : null,
      participantName,
      entityName: participantName !== entityName ? entityName : null,
      address1: data.field_y19HZi || data.field_AdoY67 || data.field_3j4IQT || data.field_T0IdZf,
      address2: data.field_bsHU5V,
      taxIdNumberType: data.field_m4nLix || ((data.field_JiKEj4 || data.field_hJkq4B) && 'Foreign'),
      taxIdNumber:
        data.field_iGedCY || data.field_nsaxM8 || data.field_JiKEj4 || data.field_hJkq4B || data.field_SXcrBL,
      country:
        data.field_ENxHCd === 'Yes'
          ? 'United States'
          : data.field_VvICe1 || data.field_SZJNur || data.field_e2uMPk || data.field_dIEvL2,
      email: data.field_gwd8pa,
      status:
        data.field_xdp45L === 'an individual person'
          ? 'Individual (or sole proprietor)'
          : data.field_ruhFN4 === 'Other (specify at the end of this form)'
            ? `Other: ${data.field_IYb1zy}`
            : data.field_ruhFN4 || data.field_xdp45L,
    };
  } else if (instance.data.Form_jmV4rR) {
    const data = instance.data.Form_jmV4rR;
    return {
      type:
        data.field_Jj5lq3 === 'Yes'
          ? 'W9'
          : data.field_W7cOxA === 'a business or entity'
            ? 'W8_BEN_E'
            : data.field_W7cOxA === 'an individual person'
              ? 'W8_BEN'
              : null,
      participantName: data.field_nTuM3q || data.field_7G0PTT || data.field_pLPdKR || data.field_TDe8mH,
      address1: data.field_Zdjn7X || data.field_nSSZij || data.field_nhEGv2,
      address2: data.field_2A7YUM,
      taxIdNumberType: data.field_GP1WVV || ((data.field_TDttcV || data.field_NwJcK9) && 'Foreign'),
      taxIdNumber:
        data.field_IHousr || data.field_U1SIy7 || data.field_YBBuNx || data.field_TDttcV || data.field_NwJcK9,
      country: data.field_Jj5lq3 === 'Yes' ? 'United States' : data.field_VjJblP || data.field_ro87Pn,
      email: data.field_LEHARZ,
      status:
        data.field_W7cOxA === 'an individual person'
          ? 'Individual (or sole proprietor)'
          : data.field_TDyswI === 'Other (specify at the end of this form)'
            ? `Other: ${data.field_uRwOOO}`
            : data.field_TDyswI || data.field_W7cOxA,
    };
  } else {
    console.warn('Could not find form data in HelloWorks instance', instance);
    return {};
  }
};

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
      MAX(ld."service") AS service,
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
  program.parse();

  const options = program.opts();
  if (!options.outputDir) {
    console.warn(
      'Output directory (--output-dir) not specified, the script will only summarize the results in the console',
    );
  }

  return { year: program.args[0], hostSlug: program.args[1], options };
};

const tryAndDecryptInstance = (encryptedFormData): HelloWorksTaxFormInstance => {
  try {
    return JSON.parse(LegalDocument.decrypt(Buffer.from(encryptedFormData, 'base64')).toString());
  } catch (e) {
    return null;
  }
};

const generateExport = async (
  hostSlug: string,
  year: number | string,
  recipients,
  { outputDir = null, filesDir = null },
) => {
  const preparedData = [];
  for (const recipient of recipients) {
    const data = JSON.parse(recipient.data);
    if (recipient.service === LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS) {
      // Legacy form
      const helloWorksInstance = tryAndDecryptInstance(data.encryptedFormData);
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
    } else if (recipient.service === LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE) {
      // TODO Implement the new export strategy here
    }
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
