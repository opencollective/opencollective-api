import EXPENSE_STATUS from './expense-status';
import EXPENSE_TYPE from './expense-type';

export const US_TAX_FORM_THRESHOLD = 600e2; // $600
export const US_TAX_FORM_THRESHOLD_FOR_PAYPAL = 100000e2; // $100,000
export const US_TAX_FORM_VALIDITY_IN_YEARS = 3;
export const TAX_FORM_IGNORED_EXPENSE_TYPES = [
  EXPENSE_TYPE.RECEIPT,
  EXPENSE_TYPE.CHARGE,
  EXPENSE_TYPE.SETTLEMENT,
  EXPENSE_TYPE.FUNDING_REQUEST, // This one is a simplification, as foundation already collects the document in their process. See https://github.com/opencollective/opencollective/issues/4766
  EXPENSE_TYPE.GRANT, // This one is a simplification, as foundation already collects the document in their process. See https://github.com/opencollective/opencollective/issues/4766
] as const;
export const TAX_FORM_IGNORED_EXPENSE_STATUSES = [
  EXPENSE_STATUS.ERROR,
  EXPENSE_STATUS.REJECTED,
  EXPENSE_STATUS.DRAFT,
  EXPENSE_STATUS.UNVERIFIED,
] as const;
