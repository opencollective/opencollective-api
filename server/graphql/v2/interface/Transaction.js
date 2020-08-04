import {
  GraphQLBoolean,
  GraphQLInterfaceType,
  // GraphQLInt,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import models from '../../../models';
import { TransactionType } from '../enum/TransactionType';
import { idEncode } from '../identifiers';
import { Amount } from '../object/Amount';
import { Expense } from '../object/Expense';
import { Order } from '../object/Order';
import { PaymentMethod } from '../object/PaymentMethod';

import { Account } from './Account';

export const Transaction = new GraphQLInterfaceType({
  name: 'Transaction',
  description: 'Transaction interface shared by all kind of transactions (Debit, Credit)',
  fields: () => {
    return {
      // _internal_id: {
      //   type: GraphQLInt,
      // },
      id: {
        type: GraphQLString,
      },
      uuid: {
        type: GraphQLString,
      },
      type: {
        type: TransactionType,
      },
      description: {
        type: GraphQLString,
      },
      amount: {
        type: Amount,
      },
      netAmount: {
        type: Amount,
      },
      platformFee: {
        type: Amount,
      },
      hostFee: {
        type: Amount,
      },
      paymentProcessorFee: {
        type: Amount,
      },
      host: {
        type: Account,
      },
      fromAccount: {
        type: Account,
      },
      toAccount: {
        type: Account,
      },
      createdAt: {
        type: GraphQLDateTime,
      },
      updatedAt: {
        type: GraphQLDateTime,
      },
      expense: {
        type: Expense,
      },
      order: {
        type: Order,
      },
      isRefunded: {
        type: GraphQLBoolean,
      },
      paymentMethod: {
        type: PaymentMethod,
      },
    };
  },
});

export const TransactionFields = () => {
  return {
    // _internal_id: {
    //   type: GraphQLInt,
    //   resolve(transaction) {
    //     return transaction.id;
    //   },
    // },
    id: {
      type: GraphQLString,
      resolve(transaction) {
        return idEncode(transaction.id, 'transaction');
      },
    },
    uuid: {
      type: GraphQLString,
    },
    type: {
      type: TransactionType,
      resolve(transaction) {
        return transaction.type;
      },
    },
    description: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.description;
      },
    },
    amount: {
      type: Amount,
      resolve(transaction) {
        return { value: transaction.amount, currency: transaction.currency };
      },
    },
    netAmount: {
      type: Amount,
      resolve(transaction) {
        return {
          value: transaction.netAmountInCollectiveCurrency,
          currency: transaction.currency,
        };
      },
    },
    platformFee: {
      type: Amount,
      resolve(transaction) {
        return {
          value: transaction.platformFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    hostFee: {
      type: Amount,
      resolve(transaction) {
        return {
          value: transaction.hostFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    paymentProcessorFee: {
      type: Amount,
      resolve(transaction) {
        return {
          value: transaction.paymentProcessorFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    host: {
      type: Account,
      resolve(transaction) {
        return transaction.getHostCollective();
      },
    },
    createdAt: {
      type: GraphQLDateTime,
      resolve(transaction) {
        return transaction.createdAt;
      },
    },
    updatedAt: {
      type: GraphQLDateTime,
      resolve(transaction) {
        // Transactions are immutable right?
        return transaction.createdAt;
      },
    },
    expense: {
      type: Expense,
      resolve(transaction, _, req) {
        if (transaction.ExpenseId) {
          return req.loaders.Expense.byId.load(transaction.ExpenseId);
        } else {
          return null;
        }
      },
    },
    order: {
      type: Order,
      resolve(transaction, _, req) {
        if (transaction.OrderId) {
          return req.loaders.Order.byId.load(transaction.OrderId);
        } else {
          return null;
        }
      },
    },
    isRefunded: {
      type: GraphQLBoolean,
      resolve(transaction) {
        return transaction.RefundTransactionId !== null;
      },
    },
    paymentMethod: {
      type: PaymentMethod,
      resolve(transaction) {
        return models.PaymentMethod.findByPk(transaction.PaymentMethodId);
      },
    },
  };
};
