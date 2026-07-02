import type express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import {
  computePaymentIntentAmountPledged,
  computePaymentIntentAmountReceived,
  computePaymentIntentAmountSent,
} from '../../../lib/payment-intents/amounts';
import { EntityShortIdPrefix } from '../../../lib/permalink/entity-map';
import models from '../../../models';
import PaymentIntent from '../../../models/PaymentIntent';
import GraphQLPaymentIntentStatus from '../enum/PaymentIntentStatus';
import GraphQLPaymentIntentType from '../enum/PaymentIntentType';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLTransaction } from '../interface/Transaction';

import { GraphQLAmount } from './Amount';
import { GraphQLExpense } from './Expense';
import { GraphQLOrder } from './Order';

const PaymentIntentAmountArgs = {
  net: {
    type: GraphQLBoolean,
    description: 'When true, excludes fees and taxes from the amount',
    defaultValue: false,
  },
};

export const GraphQLPaymentIntent = new GraphQLObjectType({
  name: 'PaymentIntent',
  description: 'A payment intent representing a charge, transfer, or pending payment',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve(paymentIntent: PaymentIntent) {
        return paymentIntent.publicId;
      },
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${EntityShortIdPrefix.PaymentIntent}_xxxxxxxx)`,
    },
    legacyId: {
      type: new GraphQLNonNull(GraphQLInt),
      deprecationReason: '2026-07-02: use publicId',
      resolve(paymentIntent: PaymentIntent) {
        return paymentIntent.id;
      },
    },
    type: {
      type: new GraphQLNonNull(GraphQLPaymentIntentType),
    },
    status: {
      type: new GraphQLNonNull(GraphQLPaymentIntentStatus),
    },
    payer: {
      type: GraphQLAccount,
      resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        if (!paymentIntent.PayerCollectiveId) {
          return null;
        }
        return req.loaders.Collective.byId.load(paymentIntent.PayerCollectiveId);
      },
    },
    payee: {
      type: GraphQLAccount,
      resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        if (!paymentIntent.PayeeCollectiveId) {
          return null;
        }
        return req.loaders.Collective.byId.load(paymentIntent.PayeeCollectiveId);
      },
    },
    host: {
      type: GraphQLAccount,
      resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        if (!paymentIntent.HostCollectiveId) {
          return null;
        }
        return req.loaders.Collective.byId.load(paymentIntent.HostCollectiveId);
      },
    },
    description: {
      type: GraphQLString,
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
    },
    paidAt: {
      type: GraphQLDateTime,
    },
    order: {
      type: GraphQLOrder,
      resolve(paymentIntent: PaymentIntent) {
        if (!paymentIntent.OrderId) {
          return null;
        }
        return models.Order.findByPk(paymentIntent.OrderId);
      },
    },
    expense: {
      type: GraphQLExpense,
      resolve(paymentIntent: PaymentIntent) {
        if (!paymentIntent.ExpenseId) {
          return null;
        }
        return models.Expense.findByPk(paymentIntent.ExpenseId);
      },
    },
    transactions: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLTransaction)),
      description: 'Transactions linked to this payment intent',
      resolve(paymentIntent: PaymentIntent, _, req: express.Request) {
        return req.loaders.PaymentIntent.transactionsByPaymentIntentId.load(paymentIntent.id);
      },
    },
    amountPledged: {
      type: GraphQLAmount,
      description: 'Intended amount from the linked order or expense',
      resolve(paymentIntent: PaymentIntent) {
        return computePaymentIntentAmountPledged(paymentIntent);
      },
    },
    amountSent: {
      type: GraphQLAmount,
      description: 'Total amount sent by the payer, computed from linked transactions',
      args: PaymentIntentAmountArgs,
      async resolve(paymentIntent: PaymentIntent, args, req: express.Request) {
        const transactions = await req.loaders.PaymentIntent.transactionsByPaymentIntentId.load(paymentIntent.id);
        return computePaymentIntentAmountSent(paymentIntent, { net: args.net, transactions });
      },
    },
    amountReceived: {
      type: GraphQLAmount,
      description: 'Total amount received by the payee, computed from linked transactions',
      args: PaymentIntentAmountArgs,
      async resolve(paymentIntent: PaymentIntent, args, req: express.Request) {
        const transactions = await req.loaders.PaymentIntent.transactionsByPaymentIntentId.load(paymentIntent.id);
        return computePaymentIntentAmountReceived(paymentIntent, { net: args.net, transactions });
      },
    },
  }),
});
