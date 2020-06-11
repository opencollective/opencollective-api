import { GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import models from '../../../models';
import { OrderFrequency, OrderStatus } from '../enum';
import { idEncode } from '../identifiers';
import { Account } from '../interface/Account';
import { Amount } from '../object/Amount';
import { PaymentMethod } from '../object/PaymentMethod';
import { Tier } from '../object/Tier';

export const Order = new GraphQLObjectType({
  name: 'Order',
  description: 'Order model',
  fields: () => {
    return {
      // _internal_id: {
      //   type: GraphQLInt,
      //   resolve(order) {
      //     return order.id;
      //   },
      // },
      id: {
        type: GraphQLString,
        resolve(order) {
          return idEncode(order.id, 'order');
        },
      },
      description: {
        type: GraphQLString,
        resolve(order) {
          return order.description;
        },
      },
      amount: {
        type: Amount,
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
        type: OrderFrequency,
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
        type: Amount,
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
    };
  },
});
