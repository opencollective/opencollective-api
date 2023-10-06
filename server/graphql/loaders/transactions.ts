import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { TransactionKind } from '../../constants/transaction-kind';
import models, { Op } from '../../models';
import { TransactionInterface } from '../../models/Transaction';

export const generateHostFeeAmountForTransactionLoader = (): DataLoader<TransactionInterface, number> =>
  new DataLoader(
    async (transactions: TransactionInterface[]) => {
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

      const keyBuilder = (transaction: TransactionInterface) => `${transaction.TransactionGroup}-${transaction.type}`;
      const groupedTransactions: Record<string, TransactionInterface[]> = groupBy(hostFeeTransactions, keyBuilder);
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

export const generateRelatedTransactionsLoader = (): DataLoader<TransactionInterface, TransactionInterface[]> =>
  new DataLoader(
    async (transactions: TransactionInterface[]) => {
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
