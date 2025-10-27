import type express from 'express';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { compact, flatten, uniq } from 'lodash';
import type { Sequelize } from 'sequelize';

import ActivityTypes from '../../../constants/activities';
import { Activity, Op, sequelize } from '../../../models';
import { GraphQLActivityCollection } from '../collection/ActivityCollection';
import { GraphQLCommunityRelationType } from '../enum/CommunityRelationType';
import { GraphQLAccount } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import { GraphQLAmount } from './Amount';

const GraphQLCommunityTransactionSummary = new GraphQLObjectType({
  name: 'CommunityTransactionSummary',
  fields: () => ({
    year: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    expenseTotal: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    expenseCount: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    contributionTotal: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    contributionCount: {
      type: new GraphQLNonNull(GraphQLInt),
    },
  }),
});

const GraphQLCommunityAssociatedCollective = new GraphQLObjectType({
  name: 'CommunityAssociatedCollective',
  fields: () => ({
    account: {
      type: GraphQLAccount,
    },
    relations: {
      type: new GraphQLList(GraphQLCommunityRelationType),
    },
  }),
});

export const GraphQLCommunityStats = new GraphQLObjectType({
  name: 'CommunityStats',
  fields: () => {
    return {
      associatedCollectives: {
        type: new GraphQLList(GraphQLCommunityAssociatedCollective),
        async resolve(account, _, req: express.Request) {
          if (account.dataValues.associatedCollectives) {
            return Promise.all(
              uniq(Object.keys(account.dataValues.associatedCollectives)).map(collectiveId =>
                req.loaders.Collective.byId.load(collectiveId).then(collective => ({
                  account: collective,
                  relations: account.dataValues.associatedCollectives[collectiveId],
                })),
              ),
            );
          }
        },
      },
      relations: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLCommunityRelationType)),
        async resolve(account) {
          if (account.dataValues.associatedCollectives) {
            return uniq(flatten(Object.values(account.dataValues.associatedCollectives)));
          } else {
            return [];
          }
        },
      },
      transactionSummary: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLCommunityTransactionSummary))),
        async resolve(account) {
          const FromCollectiveId = account.id;
          const HostCollectiveId = account.dataValues.contextualHostCollectiveId;
          // This is just a placeholder to be able to query for transactionSummary { totalAmount }
          const results = await (sequelize as Sequelize).query<{
            year: number;
            hostCurrency: string;
            expenseTotal: number;
            expenseCount: number;
            contributionTotal: number;
            contributionCount: number;
          }>(
            `
            SELECT
              EXTRACT('YEAR' FROM t."createdAt") AS "year",
              h.currency as "hostCurrency",
              COALESCE(SUM(t."amountInHostCurrency") FILTER ( WHERE t.kind = 'EXPENSE' ), 0) AS "expenseTotal",
              COALESCE(COUNT(t."id") FILTER ( WHERE t.kind = 'EXPENSE' ), 0) AS "expenseCount",
              COALESCE(SUM(t."amountInHostCurrency") FILTER ( WHERE t.kind = 'CONTRIBUTION' ), 0) AS "contributionTotal",
              COALESCE(COUNT(t."id") FILTER ( WHERE t.kind = 'CONTRIBUTION' ), 0) AS "contributionCount"
            FROM
              "Transactions" t
              INNER JOIN public."Collectives" h ON t."HostCollectiveId" = h.id
              INNER JOIN public."Collectives" c ON t."FromCollectiveId" = c.id
            WHERE t."deletedAt" IS NULL
              AND t."RefundTransactionId" IS NULL
              AND t."isRefund" = FALSE
              AND t."HostCollectiveId" = :HostCollectiveId
              AND t."FromCollectiveId" = :FromCollectiveId
              AND t.kind IN ('CONTRIBUTION', 'EXPENSE')
              AND t."hostCurrency" = h.currency
            GROUP BY
              "year", h.currency
            ORDER BY "year" DESC;
            `,
            { raw: true, type: sequelize.QueryTypes.SELECT, replacements: { FromCollectiveId, HostCollectiveId } },
          );

          return results.map(result => ({
            year: result.year,
            expenseTotal: { value: result.expenseTotal, currency: result.hostCurrency },
            expenseCount: result.expenseCount,
            contributionTotal: { value: result.contributionTotal, currency: result.hostCurrency },
            contributionCount: result.contributionCount,
          }));
        },
      },
      lastInteractionAt: {
        type: GraphQLDateTime,
        resolve(account) {
          return account?.dataValues?.lastInteractionAt;
        },
      },
      firstInteractionAt: {
        type: GraphQLDateTime,
        resolve(account) {
          return account?.dataValues?.firstInteractionAt;
        },
      },
      activities: {
        type: GraphQLActivityCollection,
        args: { ...CollectionArgs },
        async resolve(account, args = {}) {
          const { limit, offset } = args;
          const HostCollectiveId = account.dataValues.contextualHostCollectiveId;
          const UserId = account.data?.UserId;

          const where = {
            [Op.or]: compact([
              UserId && {
                UserId,
                type: [
                  ActivityTypes.USER_NEW_TOKEN,
                  ActivityTypes.USER_CHANGE_EMAIL,
                  ActivityTypes.USER_RESET_PASSWORD,
                ],
              },
              UserId && {
                UserId,
                HostCollectiveId,
                type: [
                  ActivityTypes.COLLECTIVE_APPROVED,
                  ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
                  ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
                  ActivityTypes.COLLECTIVE_EDITED,
                  ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED,
                  ActivityTypes.EXPENSE_COMMENT_CREATED,
                  ActivityTypes.COLLECTIVE_CORE_MEMBER_ADDED,
                  ActivityTypes.ORDER_PROCESSED,
                  ActivityTypes.SUBSCRIPTION_CANCELED,
                  ActivityTypes.SUBSCRIPTION_PAUSED,
                  ActivityTypes.SUBSCRIPTION_ACTIVATED,
                ],
              },
              {
                HostCollectiveId,
                FromCollectiveId: account.id,
                type: [
                  ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
                  ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
                  ActivityTypes.ORDER_PROCESSED,
                  ActivityTypes.SUBSCRIPTION_CANCELED,
                  ActivityTypes.SUBSCRIPTION_PAUSED,
                  ActivityTypes.SUBSCRIPTION_ACTIVATED,
                ],
              },
            ]),
          };

          return {
            nodes: () =>
              Activity.findAll({
                where,
                order: [['createdAt', 'DESC']],
                limit,
                offset,
              }),
            totalCount: () => Activity.count({ where }),
            limit,
            offset,
          };
        },
      },
    };
  },
});
