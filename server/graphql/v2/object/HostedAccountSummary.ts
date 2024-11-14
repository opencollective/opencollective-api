import { GraphQLFloat, GraphQLInt, GraphQLObjectType } from 'graphql';
import { min, round } from 'lodash';
import moment from 'moment';

import { GraphQLAveragePeriod } from '../enum/AveragePeriod';

import { GraphQLAmount } from './Amount';

export const HostedAccountSummary = new GraphQLObjectType({
  name: 'HostedAccountSummary',
  description:
    'Return a summary of transaction info about a given account within the context of its current fiscal host',
  fields: () => ({
    expenseCount: {
      type: GraphQLInt,
      resolve: ({ summary }) => summary?.expenseCount || 0,
    },
    expenseTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.expenseTotal || 0, currency: host.currency }),
    },
    expenseMaxValue: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.expenseMaxValue || 0, currency: host.currency }),
    },
    expenseDistinctPayee: {
      type: GraphQLInt,
      resolve: ({ summary }) => summary?.expenseDistinctPayee || 0,
    },
    contributionCount: {
      type: GraphQLInt,
      resolve: ({ summary }) => summary?.contributionCount || 0,
    },
    contributionTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.contributionTotal || 0, currency: host.currency }),
    },
    hostFeeTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.hostFeeTotal || 0, currency: host.currency }),
    },
    spentTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.spentTotal || 0, currency: host.currency }),
    },
    receivedTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.receivedTotal || 0, currency: host.currency }),
    },
    // Averages
    expenseAverageTotal: {
      type: GraphQLAmount,
      description:
        'Average calculated over the number of months the collective was approved or the number of months since dateFrom, whichever is less',
      args: {
        period: {
          type: GraphQLAveragePeriod,
          defaultValue: 'month',
        },
      },
      resolve: ({ host, summary, periods }, args) => {
        const period = periods[args.period];
        const value = period > 0 && summary?.expenseTotal ? Math.round(summary?.expenseTotal / period || 0) : 0;
        return { value, currency: host.currency };
      },
    },
    expenseAverageCount: {
      type: GraphQLFloat,
      description:
        'Average calculated over the number of months the collective was approved or the number of months since dateFrom, whichever is less',
      args: {
        period: {
          type: GraphQLAveragePeriod,
          defaultValue: 'month',
        },
      },
      resolve: ({ summary, periods }, args) => {
        const period = periods[args.period];
        const count = summary?.expenseCount || 0;
        return period > 0 ? round(count / period, 2) : 0;
      },
    },
    contributionAverageTotal: {
      type: GraphQLAmount,
      description:
        'Average calculated over the number of months the collective was approved or the number of months since dateFrom, whichever is less',
      args: {
        period: {
          type: GraphQLAveragePeriod,
          defaultValue: 'month',
        },
      },
      resolve: ({ host, summary, periods }, args) => {
        const period = periods[args.period];
        const value =
          period > 0 && summary?.contributionTotal ? Math.round(summary?.contributionTotal / period || 0) : 0;
        return { value, currency: host.currency };
      },
    },
    contributionAverageCount: {
      type: GraphQLFloat,
      description:
        'Average calculated over the number of months/years the collective was approved or the number of months since dateFrom, whichever is less',
      args: {
        period: {
          type: GraphQLAveragePeriod,
          defaultValue: 'month',
        },
      },
      resolve: ({ summary, periods }, args) => {
        const period = periods[args.period];
        const count = summary?.contributionCount || 0;
        return period > 0 ? round(count / period, 2) : 0;
      },
    },
    spentTotalAverage: {
      type: GraphQLAmount,
      args: {
        period: {
          type: GraphQLAveragePeriod,
          defaultValue: 'month',
        },
      },
      resolve: ({ host, summary, periods }, args) => {
        const period = periods[args.period];
        const value = period > 0 && summary?.spentTotal ? Math.round(summary?.spentTotal / period || 0) : 0;
        return { value, currency: host.currency };
      },
    },
    receivedTotalAverage: {
      type: GraphQLAmount,
      args: {
        period: {
          type: GraphQLAveragePeriod,
          defaultValue: 'month',
        },
      },
      resolve: ({ host, summary, periods }, args) => {
        const period = periods[args.period];
        const value = period > 0 && summary?.receivedTotal ? Math.round(summary?.receivedTotal / period || 0) : 0;
        return { value, currency: host.currency };
      },
    },
    contributionRefundedTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.contributionRefundedTotal || 0, currency: host.currency }),
    },
  }),
});

// It is OK to consider 1.4 months when calculating an average but it is misleading to consider 0.4 months.
const roundAveragePeriod = value => (value < 1 ? 1 : round(value, 1));

export const resolveHostedAccountSummary = async (account, args, req) => {
  const host = await req.loaders.Collective.byId.load(account.HostCollectiveId);
  const summary = await req.loaders.Collective.stats.hostedAccountSummary.buildLoader(args).load(account.id);

  // Periods are based on the time the collective is hosted (approved) or the number of months since dateFrom, whichever is less
  const daysSinceApproved = moment.duration(summary?.daysSinceApproved || 0, 'days');
  const monthsSinceApproved = daysSinceApproved.asMonths();
  const yearsSinceApproved = daysSinceApproved.asYears();
  let month = roundAveragePeriod(monthsSinceApproved);
  let year = roundAveragePeriod(yearsSinceApproved);
  if (args.dateFrom) {
    month = roundAveragePeriod(min([monthsSinceApproved, moment().diff(moment(args.dateFrom), 'months', true)]));
    year = roundAveragePeriod(min([yearsSinceApproved, moment().diff(moment(args.dateFrom), 'years', true)]));
  }
  return { host, summary, periods: { month, year } };
};
