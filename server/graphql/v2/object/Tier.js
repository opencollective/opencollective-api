import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import models, { Op } from '../../../models';
import { OrderCollection } from '../collection/OrderCollection';
import { OrderStatus, TierAmountType, TierInterval, TierType } from '../enum';
import { idEncode } from '../identifiers';

import { Amount } from './Amount';

export const Tier = new GraphQLObjectType({
  name: 'Tier',
  description: 'Tier model',
  fields: () => {
    return {
      // _internal_id: {
      //   type: GraphQLInt,
      //   resolve(member) {
      //     return member.id;
      //   },
      // },
      id: {
        type: GraphQLString,
        resolve(tier) {
          return idEncode(tier.id, 'tier');
        },
      },
      slug: {
        type: GraphQLString,
      },
      name: {
        type: GraphQLString,
        resolve(tier) {
          return tier.slug;
        },
      },
      description: {
        type: GraphQLString,
      },
      orders: {
        description: 'Get all orders',
        type: OrderCollection,
        args: {
          limit: { type: GraphQLInt, defaultValue: 100 },
          offset: { type: GraphQLInt, defaultValue: 0 },
          status: { type: new GraphQLList(OrderStatus) },
        },
        async resolve(tier, args) {
          const where = { TierId: tier.id };

          if (args.status && args.status.length > 0) {
            where.status = {
              [Op.in]: args.status,
            };
          }

          const result = await models.Order.findAndCountAll({ where, limit: args.limit, offset: args.offset });

          return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
        },
      },
      amount: {
        type: Amount,
        resolve(tier) {
          return { value: tier.amount, currency: tier.currency };
        },
      },
      type: {
        type: new GraphQLNonNull(TierType),
      },
      interval: {
        type: TierInterval,
      },
      presets: {
        type: new GraphQLList(GraphQLInt),
      },
      amountType: {
        type: new GraphQLNonNull(TierAmountType),
      },
      minimumAmount: {
        type: Amount,
        resolve(tier) {
          return { value: tier.minimumAmount };
        },
      },
    };
  },
});
