import { GraphQLBoolean, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import moment from 'moment';

import { GraphQLAccount } from '../interface/Account';

import { GraphQLAmount } from './Amount';

export const GraphQLContributorProfile = new GraphQLObjectType({
  name: 'ContributorProfile',
  description: 'This represents a profile that can be use to create a contribution',
  fields: () => ({
    account: {
      type: GraphQLAccount,
      description: 'The account that will be used to create the contribution',
    },
    forAccount: {
      type: GraphQLAccount,
      description: 'The account that will receive the contribution',
    },
    totalContributedToHost: {
      type: GraphQLAmount,
      description: 'The total amount contributed to the host by this contributor',
      args: {
        inCollectiveCurrency: {
          type: GraphQLBoolean,
          defaultValue: false,
          description: 'When true, the amount is converted to the currency of the collective',
        },
        since: {
          type: GraphQLDateTime,
          description: 'The date since when to calculate the total. Defaults to the start of the current year.',
        },
      },
      resolve: async ({ account, forAccount }, args, req) => {
        const host = await req.loaders.Collective.byId.load(forAccount.HostCollectiveId);
        const since = args.since ? moment(args.since).toISOString() : moment.utc().startOf('year').toISOString();
        const stats = await req.loaders.Contributors.totalContributedToHost.load({
          CollectiveId: account.id,
          HostId: host.id,
          since,
        });

        const currency = args.inCollectiveCurrency ? forAccount.currency : host.currency;
        if (!stats) {
          return { value: 0, currency };
        }

        if (args.inCollectiveCurrency && stats.currency !== currency) {
          const convertParams = { amount: stats.amount, fromCurrency: stats.currency, toCurrency: currency };
          return {
            value: await req.loaders.CurrencyExchangeRate.convert.load(convertParams),
            currency,
          };
        }
        return { value: stats.amount, currency };
      },
    },
  }),
});
