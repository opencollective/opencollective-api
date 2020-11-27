/** Types of Transactions */
export const TransactionTypes = {
  CREDIT: 'CREDIT',
  DEBIT: 'DEBIT',
};

export const FEES_ON_TOP_TRANSACTION_PROPERTIES = {
  CollectiveId: 1, // Open Collective
  HostCollectiveId: 8686, // Open Collective Inc
  hostCurrency: 'USD',
  currency: 'USD',
};

// Pia's account
export const SETTLEMENT_USER_ID = 30;

export const SETTLEMENT_PAYMENT_METHOD = {
  BANK_ACCOUNT: 2955,
  PAYPAL: 6087,
  DEFAULT: 2955,
};

export const SETTLEMENT_EXPENSE_PROPERTIES = {
  FromCollectiveId: 1,
  lastEditedById: SETTLEMENT_USER_ID,
  UserId: SETTLEMENT_USER_ID,
  payeeLocation: {
    address: '340 S Lemon Ave #3717, Walnut, CA 91789',
    country: 'US',
  },
};
