import config from 'config';
import express from 'express';
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { isNil, omit } from 'lodash';
import { OrderItem } from 'sequelize';

import { filterContributors } from '../../../lib/contributors';
import models, { Collective } from '../../../models';
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
    async resolve(account: Collective, args, req: express.Request): Promise<number> {
      if (!account.hasBudget()) {
        return 0;
      }

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
    args: {
      ...CollectionArgs,
      limit: {
        type: new GraphQLNonNull(GraphQLInt),
        description: 'The number of results to fetch',
        defaultValue: 100,
      },
    },
    async resolve(account: Collective, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (!account.hasBudget()) {
        return { nodes: [], totalCount: 0 };
      }

      const query = {
        where: { CollectiveId: account.id },
        order: [['amount', 'ASC']] as OrderItem[],
        limit: <number>args.limit,
        offset: <number>args.offset,
      };
      const result = await models.Tier.findAndCountAll(query);
      return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
    },
  },
  contributors: {
    type: new GraphQLNonNull(ContributorCollection),
    description: 'All the persons and entities that contribute to this account',
    args: {
      ...CollectionArgs,
      roles: { type: new GraphQLList(MemberRole) },
    },
    async resolve(collective: Collective, args, req): Promise<Record<string, unknown>> {
      const contributorsCache = await req.loaders.Contributors.forCollectiveId.load(collective.id);
      const contributors = contributorsCache.all || [];
      const filteredContributors = filterContributors(contributors, omit(args, ['offset', 'limit']));
      const offset = args.offset || 0;
      const limit = args.limit || 50;
      return {
        offset,
        limit,
        totalCount: filteredContributors.length,
        nodes: filteredContributors.slice(offset, limit),
      };
    },
  },
  platformFeePercent: {
    type: new GraphQLNonNull(GraphQLFloat),
    description: 'How much platform fees are charged for this account',
    resolve(account: Collective): number {
      return isNil(account.platformFeePercent) ? config.fees.default.platformPercent : account.platformFeePercent;
    },
  },
  platformContributionAvailable: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      'Returns true if a custom contribution to Open Collective can be submitted for contributions made to this account',
    async resolve(account: Collective, _, req: express.Request): Promise<boolean> {
      if (!isNil(account.data?.platformTips)) {
        return account.data.platformTips;
      }
      const host = await req.loaders.Collective.host.load(account);
      if (host) {
        const plan = await host.getPlan();
        return plan.platformTips;
      }
      return false;
    },
  },
  contributionPolicy: {
    type: GraphQLString,
  },
};

export const AccountWithContributions = new GraphQLInterfaceType({
  name: 'AccountWithContributions',
  description: 'An account that can receive financial contributions',
  fields: () => AccountWithContributionsFields,
});
