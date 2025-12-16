import config from 'config';
import { get } from 'lodash';

import {
  TAX_FORM_IGNORED_EXPENSE_STATUSES,
  TAX_FORM_IGNORED_EXPENSE_TYPES,
  US_TAX_FORM_THRESHOLD_FOR_PAYPAL,
  US_TAX_FORM_THRESHOLD_POST_2026,
  US_TAX_FORM_THRESHOLD_PRE_2026,
} from '../../constants/tax-form';
import { Collective, Expense } from '../../models';
import LegalDocument, { LEGAL_DOCUMENT_TYPE } from '../../models/LegalDocument';
import { uploadToS3 } from '../awsS3';

export const getTaxFormsS3Bucket = (): string => {
  return get(config, 'taxForms.aws.s3.bucket');
};

export const amountsRequireTaxForm = (paypalTotal: number, otherTotal: number, year: number): boolean => {
  if (paypalTotal >= US_TAX_FORM_THRESHOLD_FOR_PAYPAL) {
    return true;
  } else if (year >= 2026) {
    return otherTotal >= US_TAX_FORM_THRESHOLD_POST_2026;
  } else {
    return otherTotal >= US_TAX_FORM_THRESHOLD_PRE_2026;
  }
};

export const expenseMightBeSubjectToTaxForm = (expense: Expense): boolean => {
  return (
    !(TAX_FORM_IGNORED_EXPENSE_TYPES as readonly string[]).includes(expense.type) &&
    !(TAX_FORM_IGNORED_EXPENSE_STATUSES as readonly string[]).includes(expense.status)
  );
};

export function encryptAndUploadTaxFormToS3(
  buffer: Buffer,
  collective: Collective,
  year: number | string,
  valuesHash: string = 'none',
) {
  const bucket = getTaxFormsS3Bucket();
  const key = createTaxFormFilename({ collective, year, documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM, valuesHash });
  const encryptedBuffer = LegalDocument.encrypt(buffer);
  return uploadToS3({
    Body: encryptedBuffer,
    Bucket: bucket,
    Key: key,
    Metadata: { collectiveId: `${collective.id}`, valuesHash },
  });
}

function createTaxFormFilename({ collective, year, documentType, valuesHash }) {
  if (year >= 2023) {
    return valuesHash && valuesHash !== 'none'
      ? `${documentType}/${year}/${collective.name || collective.legalName}-${collective.id}_${valuesHash}.pdf`
      : `${documentType}/${year}/${collective.name || collective.legalName}-${collective.id}.pdf`;
  } else {
    return `${documentType}_${year}_${collective.name}.pdf`;
  }
}
