// Experimental: virtual ledger transformations for API-only exports.
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';

export const mapPlatformTipCollectiveIds = async (transactions, req) => {
  const platformTipCredits = transactions.filter(
    transaction => transaction.kind === TransactionKind.PLATFORM_TIP && transaction.type === TransactionTypes.CREDIT,
  );
  if (!platformTipCredits.length) {
    return transactions;
  }

  const relatedContributions =
    await req.loaders.Transaction.relatedContributionTransaction.loadMany(platformTipCredits);
  for (const [index, transaction] of platformTipCredits.entries()) {
    const relatedContribution = relatedContributions[index];
    const collectiveId = relatedContribution?.CollectiveId;
    if (collectiveId) {
      transaction.setDataValue('CollectiveId', collectiveId);
    }
  }

  return transactions;
};

export const mapPlatformTipDebitsToApplicationFees = async (transactions, req) => {
  const platformTipDebits = transactions.filter(
    transaction => transaction.kind === TransactionKind.PLATFORM_TIP && transaction.type === TransactionTypes.DEBIT,
  );
  if (!platformTipDebits.length) {
    return transactions;
  }

  const relatedContributions = await req.loaders.Transaction.relatedContributionTransaction.loadMany(platformTipDebits);
  for (const [index, transaction] of platformTipDebits.entries()) {
    const relatedContribution = relatedContributions[index];
    if (!relatedContribution?.CollectiveId) {
      continue;
    }
    transaction.setDataValue('kind', TransactionKind.APPLICATION_FEE);
    transaction.setDataValue('CollectiveId', relatedContribution.FromCollectiveId);
  }

  return transactions;
};
