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
  const tax = relatedCreditTransactions.find(t => t.kind === TransactionKind.TAX);

  // The net amount excludes the fees and taxes embedded in the contribution, which never reached the Collective balance.
  // Exceptions, where the refund takes the embedded fee from the Collective anyway:
  // - a legacy host fee embedded in the contribution is not given back
  // - an embedded payment processor fee is not covered by the host when the Collective is its own host
  const isSelfHosted = contribution.CollectiveId === contribution.HostCollectiveId;
  return (
    Transaction.calculateNetAmountInHostCurrency(contribution) -
    (contribution.hostFeeInHostCurrency || 0) -
    (isSelfHosted ? contribution.paymentProcessorFeeInHostCurrency || 0 : 0) -
    (hostFee?.amountInHostCurrency || 0) -
    (paymentFee?.amountInHostCurrency || 0) -
    (tax?.amountInHostCurrency || 0)
  );
};
