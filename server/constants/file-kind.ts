/**
 * Any kind added here will need to be added to `server/lib/uploaded-files.ts` as well.
 */

export const SUPPORTED_FILE_KINDS = [
  // Base fields
  'ACCOUNT_AVATAR',
  'ACCOUNT_BANNER',
  'EXPENSE_ATTACHED_FILE',
  'EXPENSE_ITEM',
  'TRANSACTIONS_IMPORT',
  // Rich text fields
  'ACCOUNT_LONG_DESCRIPTION',
  'UPDATE',
  'COMMENT',
  'TIER_LONG_DESCRIPTION',
  'CUSTOM_PAYMENT_METHOD_TEMPLATE',
  'ACCOUNT_CUSTOM_EMAIL',
  'AGREEMENT_ATTACHMENT',
  'EXPENSE_INVOICE',
  'RECEIPT_EMBEDDED_IMAGE',
] as const;

export type FileKind = (typeof SUPPORTED_FILE_KINDS)[number];
