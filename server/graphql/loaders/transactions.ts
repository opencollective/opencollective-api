import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { TransactionKind } from '../../constants/transaction-kind';
import models, { Op } from '../../models';

export const generateHostFeeAmountForTransactionLoader = (): DataLoader<typeof models.Transaction, number> =>
  new DataLoader(
    async (transactions: (typeof models.Transaction)[]) => {
      const transactionsWithoutHostFee = transactions.filter(transaction => {
        // Legacy transactions have their host fee set on `hostFeeInHostCurrency`. No need to fetch for them
        // Also only contributions and added funds can have host fees
        return !transaction.hostFeeInHostCurrency && ['CONTRIBUTION', 'ADDED_FUNDS'].includes(transaction.kind);
      });

      const hostFeeTransactions = await models.Transaction.findAll({
        attributes: ['TransactionGroup', 'type', 'amount'],
        mapToModel: false,
        raw: true,
        where: {
          kind: TransactionKind.HOST_FEE,
          [Op.or]: transactionsWithoutHostFee.map(transaction => ({
            TransactionGroup: transaction.TransactionGroup,
            type: transaction.type,
          })),
        },
      });

      const keyBuilder = transaction => `${transaction.TransactionGroup}-${transaction.type}`;
      const groupedTransactions: Record<string, typeof models.Transaction> = groupBy(hostFeeTransactions, keyBuilder);
      return transactions.map(transaction => {
        if (transaction.hostFeeInHostCurrency) {
          return transaction.hostFeeInHostCurrency;
        } else {
          const key = keyBuilder(transaction);
          const hostFeeTransactions = groupedTransactions[key];
          if (hostFeeTransactions) {
            const amount = hostFeeTransactions[0].amount;
            return transaction.isRefund ? amount : -amount;
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

export const generateRelatedTransactionsLoader = (): DataLoader<
  typeof models.Transaction,
  (typeof models.Transaction)[]
> =>
  new DataLoader(
    async (transactions: (typeof models.Transaction)[]) => {
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
