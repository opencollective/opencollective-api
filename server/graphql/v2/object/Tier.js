import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import models, { Op } from '../../../models/index.js';
import { GraphQLOrderCollection } from '../collection/OrderCollection.js';
import { GraphQLOrderStatus, GraphQLTierAmountType, GraphQLTierInterval, GraphQLTierType } from '../enum/index.js';
import { getTierFrequencyFromInterval, GraphQLTierFrequency } from '../enum/TierFrequency.js';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers.js';

import { GraphQLAmount } from './Amount.js';

export const GraphQLTier = new GraphQLObjectType({
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
        type: new GraphQLNonNull(GraphQLOrderCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
          status: { type: new GraphQLList(GraphQLOrderStatus) },
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
        type: new GraphQLNonNull(GraphQLAmount),
        resolve(tier) {
          return { value: tier.amount, currency: tier.currency };
        },
      },
      button: {
        type: GraphQLString,
      },
      goal: {
        type: new GraphQLNonNull(GraphQLAmount),
        resolve(tier) {
          return { value: tier.goal, currency: tier.currency };
        },
      },
      type: {
        type: new GraphQLNonNull(GraphQLTierType),
      },
      interval: {
        type: GraphQLTierInterval,
        deprecationReason: '2020-08-24: Please use "frequency"',
      },
      frequency: {
        type: new GraphQLNonNull(GraphQLTierFrequency),
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
        type: new GraphQLNonNull(GraphQLTierAmountType),
      },
      minimumAmount: {
        type: new GraphQLNonNull(GraphQLAmount),
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
      requireAddress: {
        type: new GraphQLNonNull(GraphQLBoolean),
        async resolve(tier) {
          return Boolean(tier.data?.requireAddress);
        },
      },
    };
  },
});
