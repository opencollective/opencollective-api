import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-scalars';

import models, { Op } from '../../../models';
import { OrderCollection } from '../collection/OrderCollection';
import { OrderStatus, TierAmountType, TierInterval, TierType } from '../enum';
import { getTierFrequencyFromInterval, TierFrequency } from '../enum/TierFrequency';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers';

import { Amount } from './Amount';

export const Tier = new GraphQLObjectType({
  name: 'Tier',
  description: 'Tier model',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve(tier) {
          return idEncode(tier.id, IDENTIFIER_TYPES.TIER);
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
      },
      description: {
        type: GraphQLString,
      },
      orders: {
        description: 'Get all orders',
        type: new GraphQLNonNull(OrderCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
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
      button: {
        type: GraphQLString,
      },
      goal: {
        type: new GraphQLNonNull(Amount),
        resolve(tier) {
          return { value: tier.goal, currency: tier.currency };
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
        type: new GraphQLNonNull(TierFrequency),
        resolve(tier) {
          return getTierFrequencyFromInterval(tier.interval);
        },
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
          return { value: tier.minimumAmount, currency: tier.currency };
        },
      },
      endsAt: {
        type: GraphQLDateTime,
      },
      invoiceTemplate: {
        type: GraphQLString,
        async resolve(tier) {
          return tier.data?.invoiceTemplate;
        },
      },
      useStandalonePage: {
        type: GraphQLBoolean,
      },
      singleTicket: {
        type: GraphQLBoolean,
        async resolve(tier) {
          return tier.data?.singleTicket;
        },
      },
    };
  },
});
