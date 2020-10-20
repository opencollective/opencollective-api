/** @module constants/transactions */

/** Percentage that Open Collective charges per transaction: 5% */
export const PLATFORM_FEE_PERCENT = 0;

/** Default per transaction host fee percentage */
export const HOST_FEE_PERCENT = 0;

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
