import {
  GraphQLBoolean,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { pick } from 'lodash';

import orderStatus from '../../../constants/order_status';
import models from '../../../models';
import * as TransactionLib from '../../common/transactions';
import { TransactionKind } from '../enum/TransactionKind';
import { TransactionType } from '../enum/TransactionType';
import { getIdEncodeResolver, idEncode, IDENTIFIER_TYPES } from '../identifiers';
import { Amount } from '../object/Amount';
import { Expense } from '../object/Expense';
import { Order } from '../object/Order';
import { PaymentMethod } from '../object/PaymentMethod';
import { TaxInfo } from '../object/TaxInfo';

import { Account } from './Account';

const TransactionPermissions = new GraphQLObjectType({
  name: 'TransactionPermissions',
  description: 'Fields for the user permissions on an transaction',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.TRANSACTION),
    },
    canRefund: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can edit the transaction',
      resolve: TransactionLib.canRefund,
    },
    canDownloadInvoice: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: "Whether the current user can download this transaction's invoice",
      resolve: TransactionLib.canDownloadInvoice,
    },
    canReject: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the current user can reject the transaction',
      resolve: TransactionLib.canReject,
    },
  }),
});

export const Transaction = new GraphQLInterfaceType({
  name: 'Transaction',
  description: 'Transaction interface shared by all kind of transactions (Debit, Credit)',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
      legacyId: {
        type: new GraphQLNonNull(GraphQLInt),
      },
      uuid: {
        type: GraphQLString,
      },
      type: {
        type: TransactionType,
      },
      kind: {
        type: TransactionKind,
      },
      description: {
        type: GraphQLString,
      },
      amount: {
        type: new GraphQLNonNull(Amount),
      },
      amountInHostCurrency: {
        type: new GraphQLNonNull(Amount),
      },
      netAmount: {
        type: new GraphQLNonNull(Amount),
      },
      taxAmount: {
        type: new GraphQLNonNull(Amount),
      },
      taxInfo: {
        type: TaxInfo,
        description: 'If taxAmount is set, this field will contain more info about the tax',
      },
      platformFee: {
        type: new GraphQLNonNull(Amount),
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
      giftCardEmitterAccount: {
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
      isRefund: {
        type: GraphQLBoolean,
      },
      paymentMethod: {
        type: PaymentMethod,
      },
      permissions: {
        type: TransactionPermissions,
      },
      isOrderRejected: {
        type: new GraphQLNonNull(GraphQLBoolean),
      },
      refundTransaction: {
        type: Transaction,
      },
    };
  },
});

export const TransactionFields = () => {
  return {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(transaction) {
        return idEncode(transaction.id, 'transaction');
      },
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      resolve(transaction) {
        return transaction.id;
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
    kind: {
      type: TransactionKind,
      resolve(transaction) {
        return transaction.kind;
      },
    },
    description: {
      type: GraphQLString,
      resolve(transaction) {
        return transaction.description;
      },
    },
    amount: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return { value: transaction.amount, currency: transaction.currency };
      },
    },
    amountInHostCurrency: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return { value: transaction.amountInHostCurrency, currency: transaction.hostCurrency };
      },
    },
    netAmount: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return {
          value: transaction.netAmountInCollectiveCurrency,
          currency: transaction.currency,
        };
      },
    },
    taxAmount: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return {
          value: transaction.taxAmount,
          currency: transaction.currency,
        };
      },
    },
    taxInfo: {
      type: TaxInfo,
      description: 'If taxAmount is set, this field will contain more info about the tax',
      resolve(transaction) {
        if (!transaction.data?.tax) {
          return null;
        } else {
          return pick(transaction.data.tax, ['id', 'percentage']);
        }
      },
    },
    platformFee: {
      type: new GraphQLNonNull(Amount),
      resolve(transaction) {
        return {
          value: transaction.platformFeeInHostCurrency || 0,
          currency: transaction.hostCurrency,
        };
      },
    },
    hostFee: {
      type: new GraphQLNonNull(Amount),
      async resolve(transaction, _, req) {
        if (transaction.hostFeeInHostCurrency) {
          return {
            value: transaction.hostFeeInHostCurrency || 0,
            currency: transaction.hostCurrency,
          };
        } else {
          return {
            value: await req.loaders.Transaction.hostFeeAmountForTransaction.load(transaction),
            currency: transaction.hostCurrency,
          };
        }
      },
    },
    paymentProcessorFee: {
      type: new GraphQLNonNull(Amount),
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
    isRefund: {
      type: GraphQLBoolean,
    },
    paymentMethod: {
      type: PaymentMethod,
      resolve(transaction) {
        return models.PaymentMethod.findByPk(transaction.PaymentMethodId);
      },
    },
    permissions: {
      type: new GraphQLNonNull(TransactionPermissions),
      description: 'The permissions given to current logged in user for this transaction',
      async resolve(transaction) {
        return transaction; // Individual fields are set by TransactionPermissions's resolvers
      },
    },
    giftCardEmitterAccount: {
      type: Account,
      description: 'Account that emitted the gift card used for this transaction (if any)',
      async resolve(transaction, _, req) {
        return transaction.UsingGiftCardFromCollectiveId
          ? await req.loaders.Collective.byId.load(transaction.UsingGiftCardFromCollectiveId)
          : null;
      },
    },
    isOrderRejected: {
      type: new GraphQLNonNull(GraphQLBoolean),
      async resolve(transaction, _, req) {
        if (transaction.OrderId) {
          const order = await req.loaders.Order.byId.load(transaction.OrderId);
          return order.status === orderStatus.REJECTED;
        } else {
          return false;
        }
      },
    },
    refundTransaction: {
      type: Transaction,
      resolve(transaction) {
        return transaction.getRefundTransaction();
      },
    },
  };
};
