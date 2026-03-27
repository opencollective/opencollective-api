/**
 * Virtual ledger transformations (export-only, no database writes).
 *
 * Context: When Raft (or any accounting integration) pulls a host's ledger,
 * platform tip transactions need to be presented differently from how they
 * are stored internally. These transforms adjust the in-memory transaction
 * objects so the exported ledger makes sense from the host's perspective.
 *
 * The two transforms are independent and composable:
 *   1. reassignPlatformTipCreditCollectives — fixes "who received this tip"
 *   2. recastPlatformTipDebitsAsApplicationFees — re-labels tip debits as application fees
 */
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';

/**
 * Reassign the CollectiveId on PLATFORM_TIP CREDIT transactions so they
 * appear under the collective that received the related contribution,
 * rather than under the platform (Open Collective) account.
 *
 * Why: Internally, a platform tip credit is booked to the OC platform
 * collective. But for the host's ledger export, Raft needs to see the
 * tip credit attributed to the same collective as the contribution it
 * accompanied, so it can reconcile the full payment in one place.
 *
 * How: For each PLATFORM_TIP CREDIT, we look up the CONTRIBUTION
 * transaction in the same TransactionGroup (via a batched data loader)
 * and copy its CollectiveId onto the tip credit.
 */
export const reassignPlatformTipCreditCollectives = async (transactions, req) => {
  const platformTipCredits = transactions.filter(
    transaction => transaction.kind === TransactionKind.PLATFORM_TIP && transaction.type === TransactionTypes.CREDIT,
  );
  if (!platformTipCredits.length) {
    return transactions;
  }

  // Batch-load the CONTRIBUTION transaction for each platform tip
  // (matched by TransactionGroup and same type: CREDIT)
  const relatedContributions =
    await req.loaders.Transaction.relatedContributionTransaction.loadMany(platformTipCredits);

  for (const [index, transaction] of platformTipCredits.entries()) {
    const relatedContribution = relatedContributions[index];
    const collectiveId = relatedContribution?.CollectiveId;
    if (collectiveId) {
      // Overwrite in-memory only (setDataValue does NOT persist to DB)
      transaction.setDataValue('CollectiveId', collectiveId);
    }
  }

  return transactions;
};

/**
 * Reassign PLATFORM_TIP_DEBT transactions so they appear between the
 * collective and the host, rather than between the OC platform and the host.
 *
 * Why: PLATFORM_TIP_DEBT records the debt that arises when a tip is collected
 * via a non-Stripe payment method (host collects the full amount including tip,
 * and owes the tip to OC). Internally, the debt is booked as OC platform ↔ host.
 * For the host's ledger export, Raft needs to see the debt attributed to the
 * collective that received the contribution, so all tip-related entries for a
 * given contribution are grouped under the same collective.
 *
 * How: For each PLATFORM_TIP_DEBT transaction, we look up the CONTRIBUTION
 * in the same TransactionGroup (via a batched data loader) and replace the
 * OC platform account with the contribution's collective:
 *   - CREDIT (host receives from OC platform): FromCollectiveId → collective
 *   - DEBIT (OC platform is debited, from host): CollectiveId → collective
 */
export const reassignPlatformTipDebtCollectives = async (transactions, req) => {
  const platformTipDebts = transactions.filter(transaction => transaction.kind === TransactionKind.PLATFORM_TIP_DEBT);
  if (!platformTipDebts.length) {
    return transactions;
  }

  const relatedContributions = await req.loaders.Transaction.relatedContributionTransaction.loadMany(platformTipDebts);

  for (const [index, transaction] of platformTipDebts.entries()) {
    const relatedContribution = relatedContributions[index];
    if (!relatedContribution) {
      continue;
    }
    if (transaction.type === TransactionTypes.CREDIT) {
      // CREDIT side: host receives from collective (replace OC platform with collective)
      transaction.setDataValue('FromCollectiveId', relatedContribution.CollectiveId);
    } else if (transaction.type === TransactionTypes.DEBIT) {
      // DEBIT side: collective is debited, from host (replace OC platform with collective)
      transaction.setDataValue('CollectiveId', relatedContribution.FromCollectiveId);
    }
  }

  return transactions;
};

/**
 * Recast PLATFORM_TIP DEBIT transactions as APPLICATION_FEE entries and
 * reassign their CollectiveId to the contributor (FromCollectiveId of the
 * related contribution).
 *
 * Why: In the internal ledger, a platform tip debit is recorded against
 * the host. But for Raft and accounting exports, it is clearer to present
 * this as an "Application Fee" charged to the contributor who opted in to
 * the tip. This avoids confusion with host fees and makes the flow of
 * funds explicit: contributor → platform tip → OC platform.
 *
 * How: For each PLATFORM_TIP DEBIT, we:
 *   1. Change the `kind` from PLATFORM_TIP to APPLICATION_FEE (a virtual,
 *      export-only kind that does not exist in stored data).
 *   2. Set CollectiveId to the contributor (FromCollectiveId of the related
 *      CONTRIBUTION), so the fee shows up against the right account.
 */
export const recastPlatformTipDebitsAsApplicationFees = async (transactions, req) => {
  const platformTipDebits = transactions.filter(
    transaction => transaction.kind === TransactionKind.PLATFORM_TIP && transaction.type === TransactionTypes.DEBIT,
  );
  if (!platformTipDebits.length) {
    return transactions;
  }

  // Batch-load the CONTRIBUTION transaction for each platform tip
  // (matched by TransactionGroup and same type: DEBIT)
  const relatedContributions = await req.loaders.Transaction.relatedContributionTransaction.loadMany(platformTipDebits);

  for (const [index, transaction] of platformTipDebits.entries()) {
    const relatedContribution = relatedContributions[index];
    if (!relatedContribution?.CollectiveId) {
      continue;
    }
    // Overwrite in-memory only (setDataValue does NOT persist to DB)
    transaction.setDataValue('kind', TransactionKind.APPLICATION_FEE);
    transaction.setDataValue('CollectiveId', relatedContribution.FromCollectiveId);
  }

  return transactions;
};
