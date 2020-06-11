import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { types as collectiveTypes } from '../../../constants/collectives';
import models from '../../../models';
import { hostResolver } from '../../common/collective';
import { TierCollection } from '../collection/TierCollection';
import { AccountType } from '../enum/AccountType';
import { Account, AccountFields } from '../interface/Account';

import { Host } from './Host';

export const Collective = new GraphQLObjectType({
  name: 'Collective',
  description: 'This represents a Collective account',
  interfaces: () => [Account],
  isTypeOf: collective => collective.type === collectiveTypes.COLLECTIVE,
  fields: () => {
    return {
      ...AccountFields,
      balance: {
        description: 'Amount of money in cents in the currency of the collective currently available to spend',
        deprecationReason: '2020/04/09 - Should not have been introduced. Use stats.balance.value',
        type: GraphQLInt,
        resolve(collective, _, req) {
          return req.loaders.Collective.balance.load(collective.id);
        },
      },
      host: {
        description: 'Get the host collective that is receiving the money on behalf of this collective',
        type: Host,
        resolve: hostResolver,
      },
      approvedAt: {
        description: 'Return this collective approved date',
        type: GraphQLDateTime,
        resolve(collective) {
          return collective.approvedAt;
        },
      },
      isApproved: {
        description: 'Returns whether this collective is approved',
        type: GraphQLBoolean,
        resolve(collective) {
          return collective.isApproved();
        },
      },
      isActive: {
        description: 'Returns whether this collective is active',
        type: GraphQLBoolean,
        resolve(collective) {
          return Boolean(collective.isActive);
        },
      },
      totalFinancialContributors: {
        description: 'Number of unique financial contributors of the collective.',
        type: GraphQLInt,
        args: {
          accountType: {
            type: AccountType,
            description: 'Type of account (COLLECTIVE/EVENT/ORGANIZATION/INDIVIDUAL)',
          },
        },
        async resolve(collective, args, req) {
          const stats = await req.loaders.Collective.stats.backers.load(collective.id);
          if (!args.accountType) {
            return stats.all;
          } else if (args.accountType === 'INDIVIDUAL') {
            return stats.USER || 0;
          } else {
            return stats[args.accountType] || 0;
          }
        },
      },
      tiers: {
        type: new GraphQLNonNull(TierCollection),
        async resolve(collective) {
          const query = { where: { CollectiveId: collective.id }, order: [['amount', 'ASC']] };
          const result = await models.Tier.findAndCountAll(query);
          return { nodes: result.rows, totalCount: result.count };
        },
      },
    };
  },
});
