import type express from 'express';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { compact, flatten, uniq, values } from 'lodash';
import type { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';

import ActivityTypes from '../../../constants/activities';
import { Activity, Collective, Op, sequelize } from '../../../models';
import { GraphQLActivityCollection } from '../collection/ActivityCollection';
import { GraphQLCommunityRelationType } from '../enum/CommunityRelationType';
import { GraphQLAccount } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import { GraphQLAmount } from './Amount';

const GraphQLCommunityTransactionSummary = new GraphQLObjectType({
  name: 'CommunityTransactionSummary',
  fields: () => ({
    year: {
      type: GraphQLInt,
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
    expenseTotalAcc: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    expenseCountAcc: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    contributionTotalAcc: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    contributionCountAcc: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    orderCount: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    orderCountAcc: {
      type: new GraphQLNonNull(GraphQLInt),
    },
  }),
});

const GraphQLCommunityAssociatedAccount = new GraphQLObjectType({
  name: 'CommunityAssociatedAccount',
  fields: () => ({
    account: {
      type: GraphQLAccount,
    },
    relations: {
      type: new GraphQLList(GraphQLCommunityRelationType),
    },
    lastInteractionAt: {
      type: GraphQLDateTime,
      async resolve(associatedAccount, _, req) {
        const { FromCollectiveId, HostCollectiveId, CollectiveId } = associatedAccount;
        const communityStats = await req.loaders.Collective.communityStats.forSpecificHostedCollective.load({
          HostCollectiveId,
          FromCollectiveId,
          CollectiveId,
        });

        return communityStats?.lastInteractionAt;
      },
    },
    firstInteractionAt: {
      type: GraphQLDateTime,
      async resolve(associatedAccount, _, req) {
        const { FromCollectiveId, HostCollectiveId, CollectiveId } = associatedAccount;
        const communityStats = await req.loaders.Collective.communityStats.forSpecificHostedCollective.load({
          HostCollectiveId,
          FromCollectiveId,
          CollectiveId,
        });

        return communityStats?.firstInteractionAt;
      },
    },
    transactionSummary: {
      type: new GraphQLNonNull(GraphQLCommunityTransactionSummary),
      async resolve(associatedAccount) {
        const { FromCollectiveId, HostCollectiveId, CollectiveId } = associatedAccount;
        const results = await (sequelize as Sequelize).query<{
          hostCurrency: string;
          expenseTotal: number;
          expenseCount: number;
          contributionTotal: number;
          contributionCount: number;
          orderCount: number;
        }>(
          `
          SELECT
            t."FromCollectiveId",
            t."HostCollectiveId",
            t."CollectiveId",
            h.currency AS "hostCurrency",
            COALESCE(SUM(t."amountInHostCurrency") FILTER (WHERE t.kind = 'EXPENSE'), 0) AS "expenseTotal",
            COALESCE(COUNT(t.id) FILTER (WHERE t.kind = 'EXPENSE'), 0) AS "expenseCount",
            COALESCE(SUM(t."amountInHostCurrency") FILTER (WHERE t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS}'::"enum_Transactions_kind"[])), 0) AS "contributionTotal",
            COALESCE(COUNT(t.id) FILTER (WHERE t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS}'::"enum_Transactions_kind"[])), 0) AS "contributionCount",
            COALESCE(COUNT(DISTINCT t."OrderId") FILTER (WHERE t.kind = ANY('{CONTRIBUTION,ADDED_FUNDS}'::"enum_Transactions_kind"[])), 0) AS "orderCount"
          FROM
            "Transactions" t
            JOIN "Collectives" h ON t."HostCollectiveId" = h.id
          WHERE t."deletedAt" IS NULL
            AND t."RefundTransactionId" IS NULL
            AND t."isRefund" = FALSE
            AND (t.kind = ANY ('{CONTRIBUTION,ADDED_FUNDS,EXPENSE}'::"enum_Transactions_kind"[]))
            AND t."hostCurrency" = h.currency
            AND t."FromCollectiveId" = :FromCollectiveId
            AND t."CollectiveId" = :CollectiveId
            AND t."HostCollectiveId" = :HostCollectiveId
          GROUP BY
            t."FromCollectiveId", t."HostCollectiveId", t."CollectiveId", h.currency
          `,
          {
            raw: true,
            type: QueryTypes.SELECT,
            replacements: { FromCollectiveId, HostCollectiveId, CollectiveId },
          },
        );
        const result = results[0];
        return {
          expenseTotal: { value: result?.expenseTotal || 0, currency: result?.hostCurrency || 'USD' },
          expenseTotalAcc: { value: result?.expenseTotal || 0, currency: result?.hostCurrency || 'USD' },
          expenseCount: result?.expenseCount || 0,
          expenseCountAcc: result?.expenseCount || 0,
          contributionTotal: { value: result?.contributionTotal || 0, currency: result?.hostCurrency || 'USD' },
          contributionTotalAcc: { value: result?.contributionTotal || 0, currency: result?.hostCurrency || 'USD' },
          contributionCount: result?.contributionCount || 0,
          contributionCountAcc: result?.contributionCount || 0,
          orderCount: result?.orderCount || 0,
          orderCountAcc: result?.orderCount || 0,
        };
      },
    },
  }),
});

export const GraphQLCommunityStats = new GraphQLObjectType({
  name: 'CommunityStats',
  fields: () => {
    return {
      associatedCollectives: {
        type: new GraphQLList(GraphQLCommunityAssociatedAccount),
        async resolve(account, _, req: express.Request) {
          if (account.dataValues.associatedCollectives) {
            const collectiveIds = Object.keys(account.dataValues.associatedCollectives);
            const collectives = await req.loaders.Collective.byId.loadMany(collectiveIds);
            const validCollectives = collectives.filter(collective => collective instanceof Collective);
            return validCollectives.map(collective => ({
              FromCollectiveId: account.id,
              HostCollectiveId: account.dataValues.contextualHostCollectiveId,
              CollectiveId: collective.id,
              account: collective,
              relations: account.dataValues.associatedCollectives[collective.id],
            }));
          }
        },
      },
      associatedOrganizations: {
        type: new GraphQLList(GraphQLCommunityAssociatedAccount),
        async resolve(account, _, req: express.Request) {
          if (account.dataValues.associatedOrganizations) {
            const organizationIds = Object.keys(account.dataValues.associatedOrganizations);
            const organizations = await req.loaders.Collective.byId.loadMany(organizationIds);
            const validOrganizations = organizations.filter(organization => organization instanceof Collective);
            return validOrganizations.map(organization => ({
              FromCollectiveId: account.id,
              HostCollectiveId: account.dataValues.contextualHostCollectiveId,
              CollectiveId: organization.id,
              account: organization,
              relations: account.dataValues.associatedOrganizations[organization.id],
            }));
          }
        },
      },
      relations: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLCommunityRelationType)),
        async resolve(account) {
          if (account.dataValues.associatedCollectives || account.dataValues.associatedOrganizations) {
            return uniq(
              flatten(
                values(account.dataValues.associatedCollectives).concat(
                  values(account.dataValues.associatedOrganizations),
                ),
              ),
            );
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
            expenseTotalAcc: number;
            expenseCountAcc: number;
            contributionTotalAcc: number;
            contributionCountAcc: number;
            orderCount: number;
            orderCountAcc: number;
          }>(
            `
            SELECT * FROM "CommunityHostTransactionSummary"
            WHERE "FromCollectiveId" = :FromCollectiveId
              AND "HostCollectiveId" = :HostCollectiveId
            ORDER BY year DESC;
            `,
            { raw: true, type: QueryTypes.SELECT, replacements: { FromCollectiveId, HostCollectiveId } },
          );

          return results.map(result => ({
            year: result.year,
            expenseTotal: { value: result.expenseTotal, currency: result.hostCurrency },
            expenseCount: result.expenseCount,
            contributionTotal: { value: result.contributionTotal, currency: result.hostCurrency },
            contributionCount: result.contributionCount,
            expenseTotalAcc: { value: result.expenseTotalAcc, currency: result.hostCurrency },
            expenseCountAcc: result.expenseCountAcc,
            contributionTotalAcc: { value: result.contributionTotalAcc, currency: result.hostCurrency },
            contributionCountAcc: result.contributionCountAcc,
            orderCount: result.orderCount,
            orderCountAcc: result.orderCountAcc,
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
              UserId && {
                UserId,
                CollectiveId: account.id,
                type: [ActivityTypes.ACTIVATED_HOSTING, ActivityTypes.DEACTIVATED_HOSTING],
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
