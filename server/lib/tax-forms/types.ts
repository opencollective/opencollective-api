export enum TaxFormCSVColumns {
  RECIPIENT_NAME = "Recipient's Name",
  ACCOUNT = 'Account',
  TYPE = 'Type',
  ENTITY = 'Entity',
  STATUS = 'Status',
  TAX_ID_TYPE = 'Tax ID Type',
  TAX_ID = 'Tax ID',
  RECIPIENT_ADDRESS_1 = 'Recipient Address (1)',
  RECIPIENT_ADDRESS_2 = 'Recipient Address (2)',
  RECIPIENT_COUNTRY = 'Recipient Country',
  RECIPIENT_EMAIL = 'Recipient Email',
  BOX_1_NONEMPLOYEE_COMPENSATION = 'Box 1 Nonemployee Compensation',
  FILE = 'File',
  DROPBOX_FORM_INSTANCE = 'Dropbox Form ID',
  PLATFORM_ID = 'Platform ID',
}

export type TaxFormCSVRow = Partial<Record<TaxFormCSVColumns, string>>;
