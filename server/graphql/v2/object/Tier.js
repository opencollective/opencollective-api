import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import GraphQLJSON from 'graphql-type-json';

import models, { Op } from '../../../models';
import { OrderCollection } from '../collection/OrderCollection';
import { ContributionFrequency, OrderStatus, TierAmountType, TierInterval, TierType } from '../enum';
import { idEncode } from '../identifiers';

import { Amount } from './Amount';

export const Tier = new GraphQLObjectType({
  name: 'Tier',
  description: 'Tier model',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve(tier) {
          return idEncode(tier.id, 'tier');
        },
      },
      legacyId: {
        type: new GraphQLNonNull(GraphQLInt),
        resolve(tier) {
          return tier.id;
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
        type: new GraphQLNonNull(Amount),
        resolve(tier) {
          return { value: tier.amount, currency: tier.currency };
        },
      },
      type: {
        type: new GraphQLNonNull(TierType),
      },
      interval: {
        type: TierInterval,
        deprecationReason: '2020-08-24: Please use "frequency"',
      },
      frequency: {
        type: ContributionFrequency,
      },
      presets: {
        type: new GraphQLList(GraphQLInt),
      },
      maxQuantity: {
        type: GraphQLInt,
      },
      availableQuantity: {
        type: GraphQLInt,
        description: 'Number of tickets available. Returns null if there is no limit.',
        resolve(tier, _, req) {
          if (!tier.maxQuantity) {
            return null;
          } else {
            return req.loaders.Tier.availableQuantity.load(tier.id);
          }
        },
      },
      customFields: {
        type: GraphQLJSON,
      },
      amountType: {
        type: new GraphQLNonNull(TierAmountType),
      },
      minimumAmount: {
        type: new GraphQLNonNull(Amount),
        resolve(tier) {
          return { value: tier.minimumAmount };
        },
      },
      endsAt: {
        type: GraphQLDateTime,
      },
    };
  },
});
