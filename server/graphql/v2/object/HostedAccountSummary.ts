import { GraphQLInt, GraphQLObjectType } from 'graphql';

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
  }),
});

export const resolveHostedAccountSummary = async (account, args, req) => {
  const host = await req.loaders.Collective.byId.load(account.HostCollectiveId);
  const summary = await req.loaders.Collective.stats.hostedAccountSummary.buildLoader(args).load(account.id);
  return { host, summary };
};
