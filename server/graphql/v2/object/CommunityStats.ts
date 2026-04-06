import type express from 'express';
import { GraphQLEnumType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { compact, flatten, uniq, values } from 'lodash';
import moment from 'moment';
import type { Sequelize } from 'sequelize';
import { QueryTypes } from 'sequelize';

import ActivityTypes from '../../../constants/activities';
import { Activity, Collective, Op, sequelize } from '../../../models';
import {
  CommunityHostTransactionSummaryRow,
  CommunityHostYearlyTransactionSummaryRow,
} from '../../../types/kysely-views';
import { GraphQLActivityCollection } from '../collection/ActivityCollection';
import { GraphQLCommunityRelationType } from '../enum/CommunityRelationType';
import { GraphQLAccount } from '../interface/Account';
import { CollectionArgs } from '../interface/Collection';

import { GraphQLAmount } from './Amount';
import { GraphQLTimeSeriesAmount } from './TimeSeriesAmount';

const GraphQLCommunityTransactionType = new GraphQLEnumType({
  name: 'CommunityTransactionType',
  values: {
    CREDIT: { value: 'CREDIT' },
    DEBIT: { value: 'DEBIT' },
    REFUND_DEBIT: { value: 'REFUND_DEBIT' },
  },
});

const GraphQLCommunityTransactionSummary = new GraphQLObjectType({
  name: 'CommunityTransactionSummary',
  fields: () => ({
    kind: {
      type: GraphQLString,
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
    refundDebitTotal: {
      type: GraphQLAmount,
    },
    refundDebitCount: {
      type: GraphQLInt,
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
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve(account) {
          return `${account.id}-${account.dataValues.contextualHostCollectiveId}`;
        },
      },
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
        async resolve(account, _, req) {
          const FromCollectiveId = account.id;
          const HostCollectiveId = account.dataValues.contextualHostCollectiveId;
          const rows = await (sequelize as Sequelize).query<CommunityHostTransactionSummaryRow>(
            `
            SELECT * FROM "CommunityHostTransactionSummary"
            WHERE "FromCollectiveId" = :FromCollectiveId
              AND "HostCollectiveId" = :HostCollectiveId;
            `,
            { raw: true, type: QueryTypes.SELECT, replacements: { FromCollectiveId, HostCollectiveId } },
          );

          if (!rows.length) {
            const host = await req.loaders.Collective.byId.load(HostCollectiveId);
            return [
              {
                kind: 'ALL',
                debitTotal: { value: 0, currency: host.currency },
                debitCount: 0,
                creditTotal: { value: 0, currency: host.currency },
                creditCount: 0,
                refundDebitTotal: { value: 0, currency: host.currency },
                refundDebitCount: 0,
              },
            ];
          }

          return rows.map(row => ({
            kind: row.kind ?? 'ALL',
            debitTotal: { value: row.debitTotal, currency: row.hostCurrency },
            debitCount: row.debitCount,
            creditTotal: { value: row.creditTotal, currency: row.hostCurrency },
            creditCount: row.creditCount,
            refundDebitTotal: { value: row.refundDebitTotal ?? 0, currency: row.hostCurrency },
            refundDebitCount: row.refundDebitCount ?? 0,
          }));
        },
      },
      transactionSummaryTimeSeries: {
        type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
        args: {
          type: {
            type: new GraphQLNonNull(GraphQLCommunityTransactionType),
            description: 'The type of transactions to return: CREDIT, DEBIT, or REFUND_DEBIT',
          },
        },
        async resolve(account, args, req) {
          const FromCollectiveId = account.id;
          const HostCollectiveId = account.dataValues.contextualHostCollectiveId;
          const results = await (sequelize as Sequelize).query<CommunityHostYearlyTransactionSummaryRow>(
            `
            SELECT * FROM "CommunityHostYearlyTransactionSummary"
            WHERE "FromCollectiveId" = :FromCollectiveId
              AND "HostCollectiveId" = :HostCollectiveId
              AND "kind" IS NULL
            ORDER BY "year" ASC;
            `,
            { raw: true, type: QueryTypes.SELECT, replacements: { FromCollectiveId, HostCollectiveId } },
          );

          let currency = 'USD';
          if (results.length > 0) {
            currency = results[0].hostCurrency || 'USD';
          } else {
            const host = await req.loaders.Collective.byId.load(HostCollectiveId);
            currency = host?.currency || 'USD';
          }

          const getAmountAndCount = (
            row: CommunityHostYearlyTransactionSummaryRow,
            type: string,
          ): { value: number; count: number } => {
            switch (type) {
              case 'CREDIT':
                return { value: row.creditTotal ?? 0, count: row.creditCount ?? 0 };
              case 'DEBIT':
                return { value: row.debitTotal ?? 0, count: row.debitCount ?? 0 };
              case 'REFUND_DEBIT':
                return { value: row.refundDebitTotal ?? 0, count: row.refundDebitCount ?? 0 };
              default:
                return { value: 0, count: 0 };
            }
          };

          const rowsByYear = new Map(results.map(row => [row.year.toString(), row]));

          const currentYear = moment.utc().year();
          const nodes: { date: Date; amount: { value: number; currency: string }; count: number }[] = [];

          if (results.length > 0) {
            const firstYear = results[0].year;
            for (let year = firstYear; year <= currentYear; year++) {
              const row = rowsByYear.get(year.toString());
              const { value, count } = getAmountAndCount(row || {}, args.type);
              nodes.push({
                date: moment.utc({ year }).toDate(),
                amount: { value, currency },
                count,
              });
            }
          }

          return {
            dateFrom: nodes.length > 0 ? nodes[0].date : null,
            dateTo: nodes.length > 0 ? nodes[nodes.length - 1].date : null,
            timeUnit: 'YEAR',
            nodes,
          };
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
