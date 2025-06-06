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
import { GraphQLDateTime } from 'graphql-scalars';
import { isNil, omit } from 'lodash';
import { OrderItem } from 'sequelize';

import PlatformConstants from '../../../constants/platform';
import { filterContributors } from '../../../lib/contributors';
import models, { Collective, sequelize } from '../../../models';
import { checkReceiveFinancialContributions } from '../../common/features';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { GraphQLContributorCollection } from '../collection/ContributorCollection';
import { GraphQLTierCollection } from '../collection/TierCollection';
import { GraphQLAccountType, GraphQLMemberRole } from '../enum';

import { CollectionArgs } from './Collection';

export const AccountWithContributionsFields = {
  totalFinancialContributors: {
    description: 'Number of unique financial contributors.',
    type: new GraphQLNonNull(GraphQLInt),
    args: {
      accountType: {
        type: GraphQLAccountType,
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
    type: new GraphQLNonNull(GraphQLTierCollection),
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
    type: new GraphQLNonNull(GraphQLContributorCollection),
    description: 'All the persons and entities that contribute to this account',
    args: {
      ...CollectionArgs,
      roles: { type: new GraphQLList(GraphQLMemberRole) },
    },
    async resolve(collective: Collective, args, req): Promise<Record<string, unknown>> {
      if (collective.isIncognito || collective.type === 'USER') {
        return { nodes: [], totalCount: 0, limit: args.limit, offset: args.offset };
      }

      const contributorsCache = await req.loaders.Contributors.forCollectiveId.load(collective.id);
      const contributors = contributorsCache.all || [];
      const filteredContributors = filterContributors(contributors, omit(args, ['offset', 'limit']));
      const offset = args.offset || 0;
      const limit = args.limit || 50;
      return {
        offset,
        limit,
        totalCount: filteredContributors.length,
        nodes: filteredContributors.slice(offset, limit + offset),
      };
    },
  },
  activeContributors: {
    type: new GraphQLNonNull(GraphQLAccountCollection),
    description: '[!] Warning: this query is currently in beta and the API might change',
    args: {
      ...CollectionArgs,
      dateFrom: { type: GraphQLDateTime },
      dateTo: { type: GraphQLDateTime },
      includeActiveRecurringContributions: { type: GraphQLBoolean },
    },
    async resolve(account, args) {
      const collectiveIdsResult = await sequelize.query(
        `WITH "CollectiveDonations" AS (
            SELECT 
              "Orders"."FromCollectiveId",
              SUM("Transactions"."amountInHostCurrency") AS total_donated
            FROM "Orders"
            INNER JOIN "Transactions" ON "Transactions"."OrderId" = "Orders".id
            WHERE "Orders"."CollectiveId" = :accountId
             ${
               args.includeActiveRecurringContributions
                 ? `
              AND (
                ("Orders".status = 'ACTIVE' AND "Orders".interval IN ('month', 'year'))
                OR ("Orders".status = 'PAID' AND "Orders"."createdAt" >= :dateFrom)
              )`
                 : ''
             }
         
              AND "Transactions".type = 'CREDIT'
              AND "Transactions"."CollectiveId" = :accountId
              AND "Transactions"."FromCollectiveId" = "Orders"."FromCollectiveId"
              AND "Transactions"."isRefund" = FALSE
              AND "Transactions"."RefundTransactionId" IS NULL
              AND "Transactions"."deletedAt" IS NULL
              AND "Orders"."deletedAt" IS NULL
              ${!args.includeActiveRecurringContributions && args.dateTo ? `AND "Transactions"."createdAt" <= :dateTo` : ''}
              ${!args.includeActiveRecurringContributions && args.dateFrom ? `AND "Transactions"."createdAt" >= :dateFrom` : ''}
            GROUP BY "Orders"."FromCollectiveId"
          )
          SELECT DISTINCT "Collectives".id, "Collectives".slug, "CollectiveDonations".total_donated
          FROM "Collectives"
          INNER JOIN "Members" m ON m."MemberCollectiveId" = "Collectives".id
          INNER JOIN "CollectiveDonations" ON "Collectives".id = "CollectiveDonations"."FromCollectiveId"
          WHERE m."CollectiveId" = :accountId 
          AND m."MemberCollectiveId" != :accountId
          AND m."deletedAt" IS NULL
          AND m."role" = 'BACKER'
          AND "Collectives"."deletedAt" IS NULL 
          AND "CollectiveDonations".total_donated > 0
          ORDER BY "CollectiveDonations".total_donated DESC;
          `,
        {
          replacements: {
            accountId: account.id,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
          },
          type: sequelize.QueryTypes.SELECT,
        },
      );

      const collectiveIds = collectiveIdsResult.map(result => result.id);

      const collectives = await models.Collective.findAll({
        where: {
          id: collectiveIds,
        },
        order: collectiveIds.length
          ? [
              // To maintain the order of total donations
              sequelize.literal(`
          CASE id
            ${collectiveIds.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ')}
            ELSE ${collectiveIds.length}
          END
        `),
            ]
          : undefined,
        offset: args.offset,
        limit: args.limit,
      });

      return {
        totalCount: collectives.length,
        nodes: collectives,
        limit: args.limit,
        offset: args.offset,
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
      } else if (PlatformConstants.AllPlatformCollectiveIds.includes(account.id)) {
        return false;
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
  canStartResumeContributionsProcess: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns true if the remote user can start the process to resume contributions for account',
    async resolve(account: Collective, _, req): Promise<boolean> {
      return (
        !account.ParentCollectiveId && // Can only be triggered on the parent
        req.remoteUser?.isAdminOfCollective(account) &&
        !account.data?.resumeContributionsStartedAt &&
        ['AVAILABLE', 'ACTIVE'].includes(await checkReceiveFinancialContributions(account, req))
      );
    },
  },
  hasResumeContributionsProcessStarted: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Returns true if the account has started the process to resume contributions',
    async resolve(account: Collective): Promise<boolean> {
      const rootAccount = account.ParentCollectiveId ? await account.getParentCollective() : account;
      return Boolean(rootAccount.data?.resumeContributionsStartedAt);
    },
  },
};

export const GraphQLAccountWithContributions = new GraphQLInterfaceType({
  name: 'AccountWithContributions',
  description: 'An account that can receive financial contributions',
  fields: () => AccountWithContributionsFields,
});
