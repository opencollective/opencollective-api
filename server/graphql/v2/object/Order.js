import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import roles from '../../../constants/roles';
import models from '../../../models';
import { ContributionFrequency, OrderStatus } from '../enum';
import { idEncode } from '../identifiers';
import { Account } from '../interface/Account';
import { Transaction } from '../interface/Transaction';
import { Amount } from '../object/Amount';
import { PaymentMethod } from '../object/PaymentMethod';
import { Tier } from '../object/Tier';

import { MemberOf } from './Member';

export const Order = new GraphQLObjectType({
  name: 'Order',
  description: 'Order model',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve(order) {
          return idEncode(order.id, 'order');
        },
      },
      legacyId: {
        type: new GraphQLNonNull(GraphQLInt),
        resolve(order) {
          return order.id;
        },
      },
      description: {
        type: GraphQLString,
        resolve(order) {
          return order.description;
        },
      },
      amount: {
        type: new GraphQLNonNull(Amount),
        resolve(order) {
          return { value: order.totalAmount, currency: order.currency };
        },
      },
      status: {
        type: OrderStatus,
        resolve(order) {
          return order.status;
        },
      },
      frequency: {
        type: ContributionFrequency,
        async resolve(order) {
          const subscription = await order.getSubscription();
          if (!subscription) {
            return 'ONETIME';
          }
          if (subscription.interval === 'month') {
            return 'MONTHLY';
          } else if (subscription.interval === 'year') {
            return 'YEARLY';
          }
        },
      },
      tier: {
        type: Tier,
        resolve(order, args, req) {
          if (order.tier) {
            return order.tier;
          }
          if (order.TierId) {
            return req.loaders.Tier.byId.load(order.TierId);
          }
        },
      },
      fromAccount: {
        type: Account,
        resolve(order) {
          return order.getFromCollective();
        },
      },
      toAccount: {
        type: Account,
        resolve(order) {
          return order.getCollective();
        },
      },
      transactions: {
        description: 'Transactions for this order ordered by createdAt ASC',
        type: new GraphQLNonNull(new GraphQLList(Transaction)),
        resolve(order, _, req) {
          return req.loaders.Transaction.byOrderId.load(order.id);
        },
      },
      createdAt: {
        type: GraphQLDateTime,
        resolve(order) {
          return order.createdAt;
        },
      },
      updatedAt: {
        type: GraphQLDateTime,
        resolve(order) {
          return order.updatedAt;
        },
      },
      totalDonations: {
        type: new GraphQLNonNull(Amount),
        description:
          'WARNING: Total amount donated between collectives, though there will be edge cases especially when looking on the Order level, as the order id is not used in calculating this.',
        async resolve(order, args, req) {
          const value = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
            FromCollectiveId: order.FromCollectiveId,
            CollectiveId: order.CollectiveId,
          });
          return { value, currency: order.currency };
        },
      },
      // needed for recurring contributions work, but we should update to encoded id and write v2 payment method object soon
      paymentMethod: {
        type: PaymentMethod,
        resolve(order) {
          return models.PaymentMethod.findByPk(order.PaymentMethodId);
        },
      },
      platformFee: {
        type: Amount,
        deprecationReason: '2020-07-31: Please use platformContributionAmount',
        resolve(order) {
          if (order.data?.isFeesOnTop) {
            return { value: order.data.platformFee };
          } else {
            return null;
          }
        },
      },
      platformContributionAmount: {
        type: Amount,
        description: 'Platform contribution attached to the Order.',
        resolve(order) {
          if (order.data?.isFeesOnTop) {
            return { value: order.data.platformFee, currency: order.currency };
          } else {
            return null;
          }
        },
      },
      membership: {
        type: MemberOf,
        description:
          'This represents a MemberOf relationship (ie: Collective backed by an Individual) attached to the Order.',
        async resolve(order) {
          return models.Member.findOne({
            where: {
              MemberCollectiveId: order.FromCollectiveId,
              CollectiveId: order.CollectiveId,
              role: roles.BACKER,
              TierId: order.TierId,
            },
          });
        },
      },
    };
  },
});
