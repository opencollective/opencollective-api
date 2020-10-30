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

export const FEES_ON_TOP_SETTLEMENT_EXPENSE_PROPERTIES = {
  FromCollectiveId: 8686,
  PayoutMethodId: 2955,
  payeeLocation: {
    address: '340 S Lemon Ave #3717, Walnut, CA 91789',
    country: 'US',
  },
  // Pia's account
  UserId: 30,
  lastEditedById: 30,
};
