import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import INTERVALS from '../../../constants/intervals';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLAmount } from './Amount';

export const GraphQLTierStats = new GraphQLObjectType({
  name: 'TierStats',
  description: 'Stats about a tier',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.TIER),
      },
      totalAmountReceived: {
        description: 'Total amount donated for this tier, in cents.',
        type: new GraphQLNonNull(GraphQLAmount),
        async resolve(tier, args, req) {
          const totalDonated = await req.loaders.Tier.totalDonated.load(tier.id);
          // TODO: consider making tier.currency explicitely not null in the database
          let currency = tier.currency;
          if (!currency) {
            tier.collective = tier.collective || (await req.loaders.Collective.byId.load(tier.CollectiveId));
            currency = tier.collective?.currency;
          }

          return { value: totalDonated, currency };
        },
      },
      recurringAmount: {
        description:
          'How much money is given for this tier for each tier.interval (monthly/yearly). For flexible tiers, this amount is a monthly average of contributions amount, taking into account both yearly and monthly subscriptions.',
        type: new GraphQLNonNull(GraphQLAmount),
        async resolve(tier, args, req) {
          let value = 0;
          let currency = tier.currency;
          // TODO: consider making tier.currency explicitely not null in the database
          if (!currency) {
            tier.collective = tier.collective || (await req.loaders.Collective.byId.load(tier.CollectiveId));
            currency = tier.collective?.currency;
          }

          if (tier.interval === INTERVALS.MONTH) {
            value = await req.loaders.Tier.totalMonthlyDonations.load(tier.id);
          } else if (tier.interval === INTERVALS.YEAR) {
            value = await req.loaders.Tier.totalYearlyDonations.load(tier.id);
          } else if (tier.interval === INTERVALS.FLEXIBLE) {
            value = await req.loaders.Tier.totalRecurringDonations.load(tier.id);
          }

          return { value, currency };
        },
      },
    };
  },
});
