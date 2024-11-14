import { GraphQLFloat, GraphQLInt, GraphQLObjectType } from 'graphql';
import { ceil, min, round } from 'lodash';
import moment from 'moment';

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
    expenseMonthlyAverageCount: {
      type: GraphQLFloat,
      description:
        'Average calculated over the number of months the collective was approved or the number of months since dateFrom, whichever is less',
      resolve: ({ summary, months }) => {
        const count = summary?.expenseCount || 0;
        return months > 0 ? round(count / months, 2) : 0;
      },
    },
    expenseTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.expenseTotal || 0, currency: host.currency }),
    },
    expenseMonthlyAverageTotal: {
      type: GraphQLAmount,
      description:
        'Average calculated over the number of months the collective was approved or the number of months since dateFrom, whichever is less',
      resolve: ({ host, summary, months }) => {
        const value = months > 0 && summary?.expenseTotal ? Math.round(summary?.expenseTotal / months || 0) : 0;
        return { value, currency: host.currency };
      },
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
    contributionMonthlyAverageCount: {
      type: GraphQLFloat,
      description:
        'Average calculated over the number of months the collective was approved or the number of months since dateFrom, whichever is less',
      resolve: ({ summary, months }) => {
        const count = summary?.contributionCount || 0;
        return months > 0 ? round(count / months, 2) : 0;
      },
    },
    contributionTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.contributionTotal || 0, currency: host.currency }),
    },
    contributionMonthlyAverageTotal: {
      type: GraphQLAmount,
      description:
        'Average calculated over the number of months the collective was approved or the number of months since dateFrom, whichever is less',
      resolve: ({ host, summary, months }) => {
        const value =
          months > 0 && summary?.contributionTotal ? Math.round(summary?.contributionTotal / months || 0) : 0;
        return { value, currency: host.currency };
      },
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
    spentTotalMonthlyAverage: {
      type: GraphQLAmount,
      resolve: ({ host, summary, months }) => {
        const value = months > 0 && summary?.spentTotal ? Math.round(summary?.spentTotal / months || 0) : 0;
        return { value, currency: host.currency };
      },
    },
    receivedTotalMonthlyAverage: {
      type: GraphQLAmount,
      resolve: ({ host, summary, months }) => {
        const value = months > 0 && summary?.receivedTotal ? Math.round(summary?.receivedTotal / months || 0) : 0;
        return { value, currency: host.currency };
      },
    },
    contributionRefundedTotal: {
      type: GraphQLAmount,
      resolve: ({ host, summary }) => ({ value: summary?.contributionRefundedTotal || 0, currency: host.currency }),
    },
  }),
});

export const resolveHostedAccountSummary = async (account, args, req) => {
  const host = await req.loaders.Collective.byId.load(account.HostCollectiveId);
  const summary = await req.loaders.Collective.stats.hostedAccountSummary.buildLoader(args).load(account.id);

  // Average calculated over the number of months the collective was approved or the number of months since dateFrom, whichever is less
  const monthsSinceApproved = moment.duration(summary?.daysSinceApproved || 0, 'days').asMonths();
  let months;
  if (args.dateFrom) {
    const monthsSinceDateFrom = moment().diff(moment(args.dateFrom), 'months', true);
    months = ceil(min([monthsSinceApproved, monthsSinceDateFrom]));
  } else {
    months = ceil(moment.duration(summary?.daysSinceApproved || 0, 'days').asMonths());
  }

  return { host, summary, months };
};
