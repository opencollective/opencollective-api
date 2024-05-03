import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { TransactionKind } from '../../constants/transaction-kind';
import models, { Op } from '../../models';
import Transaction from '../../models/Transaction';

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
