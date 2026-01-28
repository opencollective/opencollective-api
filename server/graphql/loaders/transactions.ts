import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
import models, { Op, sequelize } from '../../models';
import Transaction from '../../models/Transaction';

import { sortResultsSimple } from './helpers';

export const generateHostFeeAmountForTransactionLoader = (): DataLoader<Transaction, number> =>
  new DataLoader(
    async (transactions: Transaction[]) => {
      const transactionsWithoutHostFee = transactions.filter(transaction => {
        // Legacy transactions have their host fee set on `hostFeeInHostCurrency`. No need to fetch for them
        // Also only contributions and added funds can have host fees
        return !transaction.hostFeeInHostCurrency && Transaction.canHaveFees(transaction);
      });

      const hostFeeTransactions = await models.Transaction.findAll({
        attributes: ['TransactionGroup', 'CollectiveId', 'amountInHostCurrency'],
        mapToModel: false,
        raw: true,
        where: {
          kind: TransactionKind.HOST_FEE,
          [Op.or]: transactionsWithoutHostFee.map(transaction => ({
            TransactionGroup: transaction.TransactionGroup,
            CollectiveId: transaction.CollectiveId,
          })),
        },
      });

      const keyBuilder = (transaction: Transaction) => `${transaction.TransactionGroup}-${transaction.CollectiveId}`;
      const groupedTransactions: Record<string, Transaction[]> = groupBy(hostFeeTransactions, keyBuilder);
      return transactions.map(transaction => {
        if (transaction.hostFeeInHostCurrency) {
          return transaction.hostFeeInHostCurrency;
        } else {
          const key = keyBuilder(transaction);
          const hostFeeTransactions = groupedTransactions[key];
          if (hostFeeTransactions && Transaction.canHaveFees(transaction)) {
            return hostFeeTransactions[0].amountInHostCurrency;
          } else {
            return 0;
          }
        }
      });
    },
    {
      cacheKeyFn: transaction => transaction.id,
    },
  );

export const generatePaymentProcessorFeeAmountForTransactionLoader = (): DataLoader<Transaction, number> =>
  new DataLoader(
    async (transactions: Transaction[]) => {
      const transactionsWithoutProcessorFee = transactions.filter(transaction => {
        // Legacy transactions have their payment processor fee set on `paymentProcessorFeeInHostCurrency`. No need to fetch for them.
        // Platform tips also had processor fees as we used to split them with the collective, but we stopped doing that on 2021-04-01.
        return !transaction.paymentProcessorFeeInHostCurrency && Transaction.canHaveFees(transaction);
      });

      const processorFeesTransactions = await models.Transaction.findAll({
        attributes: ['TransactionGroup', 'CollectiveId', 'amountInHostCurrency'],
        mapToModel: false,
        raw: true,
        where: {
          kind: TransactionKind.PAYMENT_PROCESSOR_FEE,
          [Op.or]: transactionsWithoutProcessorFee.map(transaction => ({
            TransactionGroup: transaction.TransactionGroup,
            CollectiveId: transaction.CollectiveId,
          })),
        },
      });

      const keyBuilder = (transaction: Transaction) => `${transaction.TransactionGroup}-${transaction.CollectiveId}`;
      const groupedTransactions: Record<string, Transaction[]> = groupBy(processorFeesTransactions, keyBuilder);
      return transactions.map(transaction => {
        if (transaction.paymentProcessorFeeInHostCurrency) {
          return transaction.paymentProcessorFeeInHostCurrency;
        } else {
          const key = keyBuilder(transaction);
          const processorFeeTransactions = groupedTransactions[key];
          if (processorFeeTransactions && Transaction.canHaveFees(transaction)) {
            return processorFeeTransactions[0].amountInHostCurrency;
          } else {
            return 0;
          }
        }
      });
    },
    {
      cacheKeyFn: transaction => transaction.id,
    },
  );

export const generateTaxAmountForTransactionLoader = (): DataLoader<Transaction, number> =>
  new DataLoader(
    async (transactions: Transaction[]) => {
      const transactionsThatMayHaveSeparateTaxes = transactions.filter(transaction => {
        return !transaction.taxAmount && Transaction.canHaveFees(transaction);
      });

      const taxTransactions = await models.Transaction.findAll({
        attributes: ['TransactionGroup', 'CollectiveId', 'amount'], // Using `amount` as we want to return the result in transaction currency
        mapToModel: false,
        raw: true,
        where: {
          kind: TransactionKind.TAX,
          [Op.or]: transactionsThatMayHaveSeparateTaxes.map(transaction => ({
            TransactionGroup: transaction.TransactionGroup,
            CollectiveId: transaction.CollectiveId,
          })),
        },
      });

      const keyBuilder = (transaction: Transaction) => `${transaction.TransactionGroup}-${transaction.CollectiveId}`;
      const groupedTransactions: Record<string, Transaction[]> = groupBy(taxTransactions, keyBuilder);
      return transactions.map(transaction => {
        if (transaction.taxAmount) {
          return transaction.taxAmount;
        } else {
          const key = keyBuilder(transaction);
          const taxTransactions = groupedTransactions[key];
          if (taxTransactions && Transaction.canHaveFees(transaction)) {
            return taxTransactions[0].amount;
          } else {
            return 0;
          }
        }
      });
    },
    {
      cacheKeyFn: transaction => transaction.id,
    },
  );

export const generateRelatedTransactionsLoader = (): DataLoader<Transaction, Transaction[]> =>
  new DataLoader(
    async (transactions: Transaction[]) => {
      const transactionGroups = transactions.map(transaction => transaction.TransactionGroup);
      const relatedTransactions = await models.Transaction.findAll({ where: { TransactionGroup: transactionGroups } });
      const groupedTransactions = groupBy(relatedTransactions, 'TransactionGroup');
      return transactions.map(transaction => {
        if (groupedTransactions[transaction.TransactionGroup]) {
          return groupedTransactions[transaction.TransactionGroup].filter(t => t.id !== transaction.id);
        } else {
          return [];
        }
      });
    },
    {
      cacheKeyFn: transaction => transaction.id,
    },
  );

export const generateRelatedContributionTransactionLoader = (): DataLoader<Transaction, Transaction> => {
  return new DataLoader(
    async (transactions: Transaction[]) => {
      const relatedTransactions = await models.Transaction.findAll({
        where: {
          [Op.or]: transactions.map(transaction => ({
            TransactionGroup: transaction.TransactionGroup,
            kind: TransactionKind.CONTRIBUTION,
            type: transaction.type,
          })),
        },
      });
      const groupedTransactions = groupBy(relatedTransactions, 'TransactionGroup');
      return transactions.map(transaction => {
        if (groupedTransactions[transaction.TransactionGroup]) {
          return groupedTransactions[transaction.TransactionGroup].find(
            t => t.id !== transaction.id && t.type === transaction.type,
          );
        } else {
          return null;
        }
      });
    },
    {
      cacheKeyFn: transaction => transaction.id,
    },
  );
};

/**
 * Creates a loader that returns the latest carryforward date for each collective.
 * The carryforward date is the createdAt of the opening (CREDIT) BALANCE_CARRYFORWARD transaction.
 *
 * @param cachedLoaders - Cache object to store parameterized loaders
 * @returns A buildLoader function that accepts optional endDate parameter
 */
export const generateLatestCarryforwardDateLoader = (
  cachedLoaders: Record<string, DataLoader<number, Date | null>>,
): { buildLoader: (opts?: { endDate?: Date }) => DataLoader<number, Date | null> } => ({
  buildLoader({ endDate = null }: { endDate?: Date } = {}) {
    const key = `latestCarryforwardDate-${endDate?.toISOString() || 'null'}`;
    if (!cachedLoaders[key]) {
      cachedLoaders[key] = new DataLoader<number, Date | null>(async (collectiveIds: readonly number[]) => {
        // Query to get the latest BALANCE_CARRYFORWARD CREDIT (opening) transaction for each collective
        // before the given endDate
        const whereClause: Record<string, unknown> = {
          CollectiveId: collectiveIds,
          kind: TransactionKind.BALANCE_CARRYFORWARD,
          type: TransactionTypes.CREDIT, // Opening transaction
        };

        if (endDate) {
          whereClause.createdAt = { [Op.lte]: endDate };
        }

        // Use a raw query to get the MAX(createdAt) grouped by CollectiveId
        const results = (await sequelize.query(
          `
          SELECT "CollectiveId", MAX("createdAt") as "latestCarryforwardDate"
          FROM "Transactions"
          WHERE "CollectiveId" IN (:collectiveIds)
            AND "kind" = 'BALANCE_CARRYFORWARD'
            AND "type" = 'CREDIT'
            AND "deletedAt" IS NULL
            ${endDate ? 'AND "createdAt" <= :endDate' : ''}
          GROUP BY "CollectiveId"
          `,
          {
            replacements: {
              collectiveIds: [...collectiveIds],
              ...(endDate && { endDate }),
            },
            type: sequelize.QueryTypes.SELECT,
            raw: true,
          },
        )) as Array<{ CollectiveId: number; latestCarryforwardDate: Date }>;

        return sortResultsSimple(collectiveIds, results, r => r.CollectiveId, null).map(
          r => r?.latestCarryforwardDate || null,
        );
      });
    }
    return cachedLoaders[key];
  },
});
