import type { InferAttributes } from 'sequelize';

import { ValidationFailed } from '../graphql/errors';
import { Order, sequelize, Transaction, TransactionSettlement } from '../models';
import { TransactionSettlementStatus } from '../models/TransactionSettlement';
import type { LedgerWriteOverrides } from '../paymentProviders/types';

import { processOrder } from './payments';

/**
 * How the ledger should be updated when a host admin edits funds that were recorded manually
 * (added funds, manual contributions).
 */
export enum OrderEditStrategy {
  /** Reverse the existing transactions and record new ones (regular accounting practice) */
  REVERSE = 'REVERSE',
  /** Replace the existing transactions, as if they had been recorded with the new values in the first place */
  IN_PLACE = 'IN_PLACE',
}

type ReplaceOrderTransactionsParams = {
  /** The changes to apply on the order, saved atomically with the ledger changes */
  orderData: Partial<InferAttributes<Order>>;
  /**
   * The payment method to process the order with, when it's not persisted on the order (manual contributions).
   * Defaults to the payment method of the order.
   */
  paymentMethod?: Record<string, unknown>;
  invoiceTemplate?: string;
  isAddedFund?: boolean;
};

const assertTransactionsCanBeReplaced = async (
  order: Order,
  transactions: Transaction[],
  sqlTransaction: LedgerWriteOverrides['sequelizeTransaction'],
) => {
  if (order.interval || order.SubscriptionId) {
    throw new ValidationFailed('Recurring contributions cannot be edited in place');
  } else if (transactions.some(t => t.OrderId !== order.id)) {
    throw new ValidationFailed('Some of the transactions to edit do not belong to this contribution');
  } else if (transactions.some(t => t.isRefund || t.RefundTransactionId)) {
    throw new ValidationFailed('Refunded transactions cannot be edited in place');
  } else if (transactions.some(t => t.isDisputed)) {
    throw new ValidationFailed('Disputed transactions cannot be edited in place');
  }

  // Once the platform share (or tip) has been invoiced to the host, the amounts are part of an expense:
  // they can't change anymore without a proper reversal.
  const settlements = await TransactionSettlement.findAll({
    where: { TransactionGroup: transactions[0].TransactionGroup },
    transaction: sqlTransaction,
  });
  if (settlements.some(settlement => settlement.status !== TransactionSettlementStatus.OWED)) {
    throw new ValidationFailed(
      'These transactions have already been invoiced as part of a platform settlement, they cannot be edited in place. Please reverse the transactions instead.',
    );
  }
};

/**
 * Edits an order "in place": its transactions are replaced by new ones that reflect the new values
 * of the order, without recording a reversal. The new transactions keep the group and the date of
 * the ones they replace. Everything happens in a single SQL transaction.
 *
 * Only meant for orders whose transactions were recorded manually by a host admin: nothing is
 * refunded nor charged on a payment processor.
 *
 * Note that balances served from the `CollectiveBalanceCheckpoint` materialized view will only
 * reflect the change once the view is refreshed.
 *
 * @param creditTransaction the main CREDIT transaction (ADDED_FUNDS or CONTRIBUTION) to replace
 * @returns the transactions that were replaced
 */
export async function replaceOrderTransactions(
  order: Order,
  creditTransaction: Transaction,
  { orderData, paymentMethod, invoiceTemplate, isAddedFund }: ReplaceOrderTransactionsParams,
): Promise<Transaction[]> {
  const TransactionGroup = creditTransaction.TransactionGroup;
  const replacedTransactions = await sequelize.transaction(async sqlTransaction => {
    const transactions = await Transaction.findAll({
      where: { TransactionGroup },
      order: [['id', 'ASC']],
      lock: sqlTransaction.LOCK.UPDATE,
      transaction: sqlTransaction,
    });

    if (!transactions.some(t => t.id === creditTransaction.id)) {
      throw new ValidationFailed('The transactions to edit could not be found, they may have been edited already');
    }

    await assertTransactionsCanBeReplaced(order, transactions, sqlTransaction);

    // Remove existing ledger entries. Settlements are identified by their group + kind, they need to
    // be hard deleted to let the new transactions register theirs.
    await TransactionSettlement.destroy({ where: { TransactionGroup }, force: true, transaction: sqlTransaction });
    await Transaction.destroy({ where: { id: transactions.map(t => t.id) }, transaction: sqlTransaction });

    // Update the order, making sure we don't keep outdated associations around
    await order.update(orderData, { transaction: sqlTransaction });
    Object.assign(order, { collective: null, fromCollective: null, tier: null, paymentMethod: paymentMethod || null });
    await order.populate();

    const host = await order.collective.getHostCollective();
    if (!host || host.id !== creditTransaction.HostCollectiveId) {
      throw new ValidationFailed(
        'These transactions were recorded with a different fiscal host, they cannot be edited in place.',
      );
    }

    // Record the new entries
    const isSameCurrencyPair =
      creditTransaction.currency === order.currency && creditTransaction.hostCurrency === host.currency;
    const newTransaction = await processOrder(order, {
      invoiceTemplate,
      isAddedFund,
      ledgerOverrides: {
        sequelizeTransaction: sqlTransaction,
        TransactionGroup,
        createdAt: creditTransaction.createdAt,
        hostCurrencyFxRate: isSameCurrencyPair ? creditTransaction.hostCurrencyFxRate : undefined,
      },
    });

    if (!newTransaction) {
      throw new Error('Failed to record the new transactions for this contribution');
    }

    return transactions;
  });

  // Register the contributor as a member, in case the source of the funds changed (no-op otherwise)
  if (order.fromCollective?.ParentCollectiveId !== order.collective.id) {
    await order.getOrCreateMembers();
  }

  return replacedTransactions;
}
