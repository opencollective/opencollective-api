import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { TransactionKind } from '../../constants/transaction-kind';
import models, { Op } from '../../models';
import { TransactionModelInterface } from '../../models/Transaction';

export const generateHostFeeAmountForTransactionLoader = (): DataLoader<TransactionModelInterface, number> =>
  new DataLoader(async (transactions: TransactionModelInterface[]) => {
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

    const keyBuilder = (transaction: TransactionModelInterface) =>
      `${transaction.TransactionGroup}-${transaction.type}`;
    const groupedTransactions = groupBy(hostFeeTransactions, keyBuilder);
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
  });

export const generateRelatedTransactionsLoader = (): DataLoader<
  TransactionModelInterface,
  TransactionModelInterface[]
> =>
  new DataLoader(async (transactions: TransactionModelInterface[]) => {
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
  });
