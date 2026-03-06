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
    debitTotal: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    debitCount: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    creditTotal: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    creditCount: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    debitTotalAcc: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    debitCountAcc: {
      type: new GraphQLNonNull(GraphQLInt),
    },
    creditTotalAcc: {
      type: new GraphQLNonNull(GraphQLAmount),
    },
    creditCountAcc: {
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
          debitTotal: number;
          debitCount: number;
          creditTotal: number;
          creditCount: number;
        }>(
          `
          SELECT
            t."FromCollectiveId",
            t."HostCollectiveId",
            t."CollectiveId",
            h.currency AS "hostCurrency",
            COALESCE(SUM(t."amountInHostCurrency") FILTER (WHERE t.type = 'DEBIT'), 0) AS "debitTotal",
            COALESCE(COUNT(t.id) FILTER (WHERE t.type = 'DEBIT'), 0) AS "debitCount",
            COALESCE(SUM(t."amountInHostCurrency") FILTER (WHERE t.type = 'CREDIT'), 0) AS "creditTotal",
            COALESCE(COUNT(t.id) FILTER (WHERE t.type = 'CREDIT'), 0) AS "creditCount"
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
          debitTotal: { value: result?.debitTotal || 0, currency: result?.hostCurrency || 'USD' },
          debitTotalAcc: { value: result?.debitTotal || 0, currency: result?.hostCurrency || 'USD' },
          debitCount: result?.debitCount || 0,
          debitCountAcc: result?.debitCount || 0,
          creditTotal: { value: result?.creditTotal || 0, currency: result?.hostCurrency || 'USD' },
          creditTotalAcc: { value: result?.creditTotal || 0, currency: result?.hostCurrency || 'USD' },
          creditCount: result?.creditCount || 0,
          creditCountAcc: result?.creditCount || 0,
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
            debitTotal: number;
            debitCount: number;
            creditTotal: number;
            creditCount: number;
            debitTotalAcc: number;
            debitCountAcc: number;
            creditTotalAcc: number;
            creditCountAcc: number;
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
            debitTotal: { value: result.debitTotal, currency: result.hostCurrency },
            debitCount: result.debitCount,
            creditTotal: { value: result.creditTotal, currency: result.hostCurrency },
            creditCount: result.creditCount,
            debitTotalAcc: { value: result.debitTotalAcc, currency: result.hostCurrency },
            debitCountAcc: result.debitCountAcc,
            creditTotalAcc: { value: result.creditTotalAcc, currency: result.hostCurrency },
            creditCountAcc: result.creditCountAcc,
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
