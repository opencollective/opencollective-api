import { GraphQLBoolean, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { pick } from 'lodash';

import {
  getSumCollectivesAmountReceived,
  getSumCollectivesAmountSpent,
  sumTransactionsInCurrency,
} from '../../../lib/budget';

import { GraphQLAmount } from './Amount';

const HostStatsArgs = {
  net: {
    type: GraphQLBoolean,
    description: 'Return the net amount (with payment processor fees removed)',
    defaultValue: false,
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Calculate amount after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Calculate amount before this date',
  },
  includeGiftCards: {
    type: GraphQLBoolean,
    description: 'Include transactions using Gift Cards',
    defaultValue: false,
  },
};

export const GraphQLHostStats = new GraphQLObjectType({
  name: 'HostStats',
  fields: () => ({
    balance: {
      type: GraphQLAmount,
      args: pick(HostStatsArgs, ['dateTo']),
      resolve: async ({ host, collectiveIds }, args, req) => {
        const totalMoneyManaged = await host.getTotalMoneyManaged({
          endDate: args.dateTo,
          collectiveIds,
          loaders: req.loaders,
        });

        return { value: totalMoneyManaged, currency: host.currency };
      },
    },
    totalAmountSpent: {
      type: GraphQLAmount,
      args: pick(HostStatsArgs, ['dateTo', 'dateFrom', 'net', 'includeGiftCards']),

      resolve: async ({ host, collectiveIds }, args, req) => {
        const results = await getSumCollectivesAmountSpent(collectiveIds, {
          net: args.net,
          startDate: args.dateFrom,
          endDate: args.dateTo,
          includeGiftCards: args.includeGiftCards,
          loaders: req.loaders,
        });
        const totalAmountSpent = await sumTransactionsInCurrency(results, host.currency);

        return { value: totalAmountSpent, currency: host.currency };
      },
    },
    totalAmountReceived: {
      type: GraphQLAmount,
      args: pick(HostStatsArgs, ['dateTo', 'dateFrom', 'net']),

      resolve: async ({ host, collectiveIds }, args, req) => {
        const results = await getSumCollectivesAmountReceived(collectiveIds, {
          net: args.net,
          startDate: args.dateFrom,
          endDate: args.dateTo,
          loaders: req.loaders,
        });
        const totalAmountReceieved = await sumTransactionsInCurrency(results, host.currency);

        return { value: totalAmountReceieved, currency: host.currency };
      },
    },
  }),
});
