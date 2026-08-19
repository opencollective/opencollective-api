import assert from 'assert';

import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import { Transaction } from '../models';

/**
 * Returns the total amount, in host currency cents, that should be refunded from the Collective balance.
 */
export const getRefundableAmountFromCollectiveInHostCurrency = async (transaction: Transaction): Promise<number> => {
  const relatedCreditTransactions = await transaction.getRelatedTransactions({ type: TransactionTypes.CREDIT });
  const contribution = relatedCreditTransactions.find(t =>
    [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS, TransactionKind.BALANCE_TRANSFER].includes(t.kind),
  );
  assert(contribution, 'No contributions found for this transaction');
  const hostFee = relatedCreditTransactions.find(t => t.kind === TransactionKind.HOST_FEE);
  const paymentFee = relatedCreditTransactions.find(t => t.kind === TransactionKind.PAYMENT_PROCESSOR_FEE);

  return (
    contribution.amountInHostCurrency - (hostFee?.amountInHostCurrency || 0) - (paymentFee?.amountInHostCurrency || 0)
  );
};
