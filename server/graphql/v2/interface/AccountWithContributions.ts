import { GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLNonNull } from 'graphql';

import { getPaginatedContributorsForCollective } from '../../../lib/contributors';
import models from '../../../models';
import { ContributorCollection } from '../collection/ContributorCollection';
import { TierCollection } from '../collection/TierCollection';
import { AccountType, MemberRole } from '../enum';

import { CollectionArgs } from './Collection';

export const AccountWithContributionsFields = {
  totalFinancialContributors: {
    description: 'Number of unique financial contributors.',
    type: new GraphQLNonNull(GraphQLInt),
    args: {
      accountType: {
        type: AccountType,
        description: 'Type of account (COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL)',
      },
    },
    async resolve(account, args, req): Promise<number> {
      const stats = await req.loaders.Collective.stats.backers.load(account.id);
      if (!args.accountType) {
        return stats.all || 0;
      } else if (args.accountType === 'INDIVIDUAL') {
        return stats.USER || 0;
      } else {
        return stats[args.accountType] || 0;
      }
    },
  },
  tiers: {
    type: new GraphQLNonNull(TierCollection),
    async resolve(account): Promise<object> {
      const query = { where: { CollectiveId: account.id }, order: [['amount', 'ASC']] };
      const result = await models.Tier.findAndCountAll(query);
      return { nodes: result.rows, totalCount: result.count };
    },
  },
  contributors: {
    type: new GraphQLNonNull(ContributorCollection),
    description: 'All the persons and entities that contribute to this account',
    args: {
      ...CollectionArgs,
      roles: { type: new GraphQLList(MemberRole) },
    },
    resolve(collective, args): Promise<object> {
      return getPaginatedContributorsForCollective(collective.id, args);
    },
  },
  balance: {
    description: 'Amount of money in cents in the currency of the account currently available to spend',
    deprecationReason: '2020/04/09 - Should not have been introduced. Use stats.balance.value',
    type: GraphQLInt,
    resolve(account, _, req): Promise<number> {
      return req.loaders.Collective.balance.load(account.id);
    },
  },
};

export const AccountWithContributions = new GraphQLInterfaceType({
  name: 'AccountWithContributions',
  description: 'An account that can receive financial contributions',
  fields: () => AccountWithContributionsFields,
});
