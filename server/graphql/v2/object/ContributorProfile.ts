import { GraphQLBoolean, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import moment from 'moment';

import { getFxRate } from '../../../lib/currency';
import type { ContributorsLoaders } from '../../loaders/contributors';
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
          description: 'The date since when to calculate the total',
        },
      },
      resolve: async ({ account, forAccount }, args, req) => {
        const host = await req.loaders.Collective.byId.load(forAccount.HostCollectiveId);
        const since = moment(args.since).toISOString() || moment.utc().startOf('year').toISOString();
        const stats = await (req.loaders.Contributors as ContributorsLoaders).totalContributedToHost
          .buildLoader({ hostId: host.id, since })
          .load(account.id);

        const currency = args.inCollectiveCurrency ? forAccount.currency : host.currency;
        if (!stats) {
          return { value: 0, currency };
        }

        if (args.inCollectiveCurrency && stats.currency !== currency) {
          const fxRate = await getFxRate(stats.currency, currency);
          return { value: Math.round(stats.amount * fxRate), currency };
        }
        return { value: stats.amount, currency };
      },
    },
  }),
});
