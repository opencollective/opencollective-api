import DataLoader from 'dataloader';
import { find, groupBy, isEmpty } from 'lodash';

import { TransactionKind } from '../../constants/transaction-kind';
import { TransactionTypes } from '../../constants/transactions';
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

export const generatePaymentProcessorFeeAmountForTransactionLoader = (): DataLoader<TransactionInterface, number> =>
  new DataLoader(
    async (transactions: TransactionInterface[]) => {
      const transactionsWithoutProcessorFee = transactions.filter(transaction => {
        // Legacy transactions have their payment processor fee set on `paymentProcessorFeeInHostCurrency`. No need to fetch for them.
        // Platform tips also had processor fees as we used to split them with the collective, but we stopped doing that on 2021-04-01.
        return (
          !transaction.paymentProcessorFeeInHostCurrency &&
          ['EXPENSE', 'ADDED_FUNDS', 'CONTRIBUTION'].includes(transaction.kind)
        );
      });

      const processorFeesTransactions = await models.Transaction.findAll({
        attributes: ['TransactionGroup', 'type', 'amountInHostCurrency', 'CollectiveId'],
        mapToModel: false,
        raw: true,
        where: {
          kind: TransactionKind.PAYMENT_PROCESSOR_FEE,
          [Op.or]: transactionsWithoutProcessorFee.map(transaction => ({
            TransactionGroup: transaction.TransactionGroup,
            type: transaction.type,
          })),
        },
      });

      // const keyBuilder = (transaction: TransactionInterface) => `${transaction.TransactionGroup}-${transaction.type}`;
      const groupedTransactions: Record<string, TransactionInterface[]> = groupBy(
        processorFeesTransactions,
        'TransactionGroup',
      );
      return transactions.map(transaction => {
        if (transaction.paymentProcessorFeeInHostCurrency) {
          return transaction.paymentProcessorFeeInHostCurrency;
        } else {
          // const key = keyBuilder(transaction);
          const processorFeeTransactions = groupedTransactions[transaction.TransactionGroup];
          if (!isEmpty(processorFeeTransactions)) {
            const processorFeeTransaction =
              // 1st we try to match the same CollectiveId to guarantee transaction type consistency
              // find(processorFeeTransactions, { CollectiveId: transaction.CollectiveId }) ||
              // 2nd we fall back to debit, because a fee should always be negative unless the beneficiary of transaction is the processor itself (catch on 1st condition)
              find(processorFeeTransactions, {
                type: transaction.isRefund ? TransactionTypes.CREDIT : TransactionTypes.DEBIT,
              }) ||
              // Fall back to the first one
              processorFeeTransactions[0];
            return processorFeeTransaction.amountInHostCurrency;
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

export const generateTaxAmountForTransactionLoader = (): DataLoader<TransactionInterface, number> =>
  new DataLoader(
    async (transactions: TransactionInterface[]) => {
      const transactionsThatMayHaveSeparateTaxes = transactions.filter(transaction => {
        return !transaction.taxAmount && ['EXPENSE', 'ADDED_FUNDS', 'CONTRIBUTION'].includes(transaction.kind);
      });

      const taxTransactions = await models.Transaction.findAll({
        attributes: ['TransactionGroup', 'type', 'amount'], // Using `amount` as we want to return the result in transaction currency
        mapToModel: false,
        raw: true,
        where: {
          kind: TransactionKind.TAX,
          [Op.or]: transactionsThatMayHaveSeparateTaxes.map(transaction => ({
            TransactionGroup: transaction.TransactionGroup,
            type: transaction.type,
          })),
        },
      });

      const keyBuilder = (transaction: TransactionInterface) => `${transaction.TransactionGroup}-${transaction.type}`;
      const groupedTransactions: Record<string, TransactionInterface[]> = groupBy(taxTransactions, keyBuilder);
      return transactions.map(transaction => {
        if (transaction.taxAmount) {
          return transaction.taxAmount;
        } else {
          const key = keyBuilder(transaction);
          const taxTransactions = groupedTransactions[key];
          if (taxTransactions) {
            const amount = taxTransactions[0].amount;
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
