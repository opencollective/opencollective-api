import { GraphQLBoolean, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import moment from 'moment';

import { CollectiveType } from '../../../constants/collectives';
import type { Collective } from '../../../models';
import type { TotalContributedToHost } from '../../loaders/contributors';
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
      resolve: async (
        { account, forAccount }: { account: Collective; forAccount: Collective },
        args,
        req: Express.Request,
      ) => {
        if (!req.remoteUser || !req.remoteUser?.isAdminOfCollective(account)) {
          return null;
        }

        const host = await req.loaders.Collective.byId.load(forAccount.HostCollectiveId);
        const since = args.since ? moment(args.since).toISOString() : moment.utc().startOf('year').toISOString();

        let stats: TotalContributedToHost | null;
        // If Account is a user, we need to combine both contributions from the user and a potential incognito profile
        const incognitoMember = account.type === CollectiveType.USER && (await account.getIncognitoMember());
        if (incognitoMember) {
          const [individual, incognito]: Array<TotalContributedToHost | undefined> =
            await req.loaders.Contributors.totalContributedToHost.loadMany(
              [incognitoMember.MemberCollectiveId, incognitoMember.CollectiveId].map(CollectiveId => ({
                CollectiveId,
                HostId: host.id,
                since,
              })),
            );
          if (!individual && !incognito) {
            stats = null;
          } else if (individual && incognito) {
            stats = {
              CollectiveId: account.id,
              amount: individual.amount + incognito.amount,
              currency: individual.currency,
              HostCollectiveId: host.id,
              since,
            };
          } else {
            stats = individual || incognito;
          }
        } else {
          stats = await req.loaders.Contributors.totalContributedToHost.load({
            CollectiveId: account.id,
            HostId: host.id,
            since,
          });
        }

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
