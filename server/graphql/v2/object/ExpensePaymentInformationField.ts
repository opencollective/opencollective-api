import type Express from 'express';
import { GraphQLObjectType } from 'graphql';
import { find } from 'lodash';

import expenseStatus from '../../../constants/expense-status';
import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionTypes } from '../../../constants/transactions';
import ExpenseModel from '../../../models/Expense';

import { GraphQLAmount } from './Amount';

export const GraphQLExpensePaymentInformationField = new GraphQLObjectType<ExpenseModel, Express.Request>({
  name: 'ExpensePaymentInformationField',
  description: 'Payment information for a paid expense',
  fields: () => ({
    processorFee: {
      type: GraphQLAmount,
      description: 'The payment processor fee for this expense (in host currency)',
      async resolve(expense, _, req) {
        if (expense.status !== expenseStatus.PAID) {
          return null;
        }

        const transactions = await req.loaders.Transaction.byExpenseId.load(expense.id);
        const transaction = find(transactions, {
          kind: TransactionKind.PAYMENT_PROCESSOR_FEE,
          isRefund: false,
          type: TransactionTypes.DEBIT,
          RefundTransactionId: null,
        });

        if (!transaction) {
          return null;
        }

        return {
          value: Math.abs(transaction.amountInHostCurrency || 0),
          currency: transaction.hostCurrency,
          exchangeRate: null,
        };
      },
    },
  }),
});
