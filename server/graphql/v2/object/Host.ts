import assert from 'assert';

import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { compact, get, isEmpty, isNil, keyBy, mapValues, pick, set, uniq } from 'lodash';
import moment from 'moment';
import { QueryTypes } from 'sequelize';

import ActivityTypes from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';
import { FEATURE } from '../../../lib/allowed-features';
import { listMatchingDimensionValues } from '../../../lib/metrics';
import { GraphQLMetricsDateRangeInput, hostMetricsField } from '../../../lib/metrics/graphql';
import {
  HostedCollectivesFinancialActivity,
  HostedCollectivesHostingPeriods,
  HostedCollectivesMembership,
} from '../../../lib/metrics/sources';
import { EntityShortIdPrefix } from '../../../lib/permalink/entity-map';
import SQLQueries from '../../../lib/queries';
import sequelize from '../../../lib/sequelize';
import { buildSearchConditions } from '../../../lib/sql-search';
import { getHostReportNodesFromQueryResult } from '../../../lib/transaction-reports';
import { ifStr } from '../../../lib/utils';
import models, { Collective, Op } from '../../../models';
import Agreement from '../../../models/Agreement';
import { LEGAL_DOCUMENT_TYPE } from '../../../models/LegalDocument';
import { checkRemoteUserCanUseHost } from '../../common/scope-check';
import { Unauthorized, ValidationFailed } from '../../errors';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { GraphQLAgreementCollection } from '../collection/AgreementCollection';
import { GraphQLHostApplicationCollection } from '../collection/HostApplicationCollection';
import { GraphQLHostedAccountCollection } from '../collection/HostedAccountCollection';
import { GraphQLLegalDocumentCollection } from '../collection/LegalDocumentCollection';
import { GraphQLVirtualCardCollection } from '../collection/VirtualCardCollection';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../enum';
import { GraphQLHostApplicationStatus } from '../enum/HostApplicationStatus';
import GraphQLHostContext from '../enum/HostContext';
import { GraphQLHostFeeStructure } from '../enum/HostFeeStructure';
import { GraphQLLastCommentBy } from '../enum/LastCommentByType';
import { GraphQLLegalDocumentRequestStatus } from '../enum/LegalDocumentRequestStatus';
import { GraphQLLegalDocumentType } from '../enum/LegalDocumentType';
import { GraphQLTimeUnit, TimeUnit } from '../enum/TimeUnit';
import { GraphQLVirtualCardStatusEnum } from '../enum/VirtualCardStatus';
import {
  fetchAccountsIdsWithReference,
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import {
  ACCOUNT_BALANCE_QUERY,
  ACCOUNT_CONSOLIDATED_BALANCE_QUERY,
  getAmountRangeValueAndOperator,
  GraphQLAmountRangeInput,
} from '../input/AmountRangeInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../input/ChronologicalOrderInput';
import { GraphQLOrderByInput, ORDER_BY_PSEUDO_FIELDS } from '../input/OrderByInput';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import {
  AccountWithPlatformSubscriptionFields,
  GraphQLAccountWithPlatformSubscription,
} from '../interface/AccountWithPlatformSubscription';
import { CollectionArgs, getCollectionArgs } from '../interface/Collection';
import URL from '../scalar/URL';

import { GraphQLHostExpensesReports } from './HostExpensesReport';
import { GraphQLHostMetrics } from './HostMetrics';
import { GraphQLHostMetricsTimeSeries } from './HostMetricsTimeSeries';
import { GraphQLHostPlan } from './HostPlan';
import { GraphQLHostStats } from './HostStats';
import { GraphQLHostTransactionReports } from './HostTransactionReports';
import { getOrganizationFields } from './Organization';

const getNumberOfDays = (startDate, endDate, host) => {
  const momentStartDate = startDate && moment(startDate);
  const momentCreated = moment(host.createdAt);
  const momentFrom = momentStartDate?.isAfter(momentCreated) ? momentStartDate : momentCreated; // We bound the date range to the host creation date
  const momentTo = moment(endDate || undefined); // Defaults to Today
  return Math.abs(momentFrom.diff(momentTo, 'days'));
};

const getTimeUnit = numberOfDays => {
  if (numberOfDays < 21) {
    return 'DAY'; // Up to 3 weeks
  } else if (numberOfDays < 90) {
    return 'WEEK'; // Up to 3 months
  } else if (numberOfDays < 365 * 3) {
    return 'MONTH'; // Up to 3 years
  } else {
    return 'YEAR';
  }
};

export const GraphQLHost = new GraphQLObjectType({
  name: 'Host',
  description: 'This represents an Host account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithContributions, GraphQLAccountWithPlatformSubscription],
  // Due to overlap between our Organization and Host types, we cannot use isTypeOf here
  // isTypeOf: account => account.hasMoneyManagement,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      ...AccountWithPlatformSubscriptionFields,
      hostFeePercent: {
        type: GraphQLFloat,
        resolve(collective) {
          return collective.hostFeePercent;
        },
      },
      totalHostedCollectives: {
        type: GraphQLInt,
        deprecationReason: '2023-03-20: Renamed to totalHostedAccounts',
        resolve(host, _, req) {
          return req.loaders.Collective.hostedCollectivesCount.load(host.id);
        },
      },
      totalHostedAccounts: {
        type: GraphQLInt,
        resolve(host, _, req) {
          return req.loaders.Collective.hostedCollectivesCount.load(host.id);
        },
      },
      isOpenToApplications: {
        type: GraphQLBoolean,
        resolve(collective) {
          return collective.canApply();
        },
      },
      termsUrl: {
        type: URL,
        resolve(collective) {
          return get(collective, 'settings.tos');
        },
      },
      plan: {
        type: new GraphQLNonNull(GraphQLHostPlan),
        deprecationReason: '2026-04-02: Replaced by new pricing',
        resolve(host) {
          return host.getLegacyPlan();
        },
      },
      hostTransactionsReports: {
        type: GraphQLHostTransactionReports,
        description: 'EXPERIMENTAL (this may change or be removed)',
        args: {
          timeUnit: {
            type: GraphQLTimeUnit,
            defaultValue: 'MONTH',
          },
          dateFrom: {
            type: GraphQLDateTime,
          },
          dateTo: {
            type: GraphQLDateTime,
          },
        },
        resolve: async (host, args) => {
          if (args.timeUnit !== 'MONTH' && args.timeUnit !== 'QUARTER' && args.timeUnit !== 'YEAR') {
            throw new Error('Only monthly, quarterly and yearly reports are supported.');
          }

          const refreshedAtQuery = `
            SELECT "refreshedAt" FROM "HostMonthlyTransactions" LIMIT 1;
          `;

          const refreshedAtResult = await sequelize.query<{ refreshedAt: Date }>(refreshedAtQuery, {
            replacements: {
              hostCollectiveId: host.id,
            },
            type: QueryTypes.SELECT,
            raw: true,
          });

          const refreshedAt = refreshedAtResult[0]?.refreshedAt;

          const query = `
            WITH
                HostCollectiveIds AS (
                    SELECT "id"
                    FROM "Collectives"
                    WHERE ("id" = :hostCollectiveId OR ("ParentCollectiveId" = :hostCollectiveId AND "type" != 'VENDOR')) AND "deletedAt" IS NULL
                ),
                AggregatedTransactions AS (
                    SELECT
                        DATE_TRUNC(:timeUnit, t."createdAt" AT TIME ZONE 'UTC') AS "date",
                        t."HostCollectiveId",
                        SUM(t."amountInHostCurrency") AS "amountInHostCurrency",
                        SUM(COALESCE(t."platformFeeInHostCurrency", 0)) AS "platformFeeInHostCurrency",
                        SUM(COALESCE(t."hostFeeInHostCurrency", 0)) AS "hostFeeInHostCurrency",
                        SUM(
                            COALESCE(t."paymentProcessorFeeInHostCurrency", 0)
                        ) AS "paymentProcessorFeeInHostCurrency",
                        SUM(
                            COALESCE(
                                t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1),
                                0
                            )
                        ) AS "taxAmountInHostCurrency",
                        COALESCE(
                            SUM(COALESCE(t."amountInHostCurrency", 0)) + SUM(COALESCE(t."platformFeeInHostCurrency", 0)) + SUM(COALESCE(t."hostFeeInHostCurrency", 0)) + SUM(
                                COALESCE(t."paymentProcessorFeeInHostCurrency", 0)
                            ) + SUM(
                                COALESCE(
                                    t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1),
                                    0
                                )
                            ),
                            0
                        ) AS "netAmountInHostCurrency",
                        t."kind",
                        t."isRefund",
                        t."hostCurrency",
                        t."type",
                        CASE
                            WHEN t."CollectiveId" IN (SELECT * FROM HostCollectiveIds) THEN TRUE ELSE FALSE
                        END AS "isHost",
                        e."type" AS "expenseType"
                    FROM
                        "Transactions" t
                        LEFT JOIN LATERAL (
                            SELECT
                                e2."type"
                            FROM
                                "Expenses" e2
                            WHERE
                                e2.id = t."ExpenseId"
                        ) AS e ON t."ExpenseId" IS NOT NULL
                    WHERE
                        t."deletedAt" IS NULL
                        AND t."HostCollectiveId" = :hostCollectiveId
                        AND t."createdAt" > :refreshedAt
                        ${args.dateTo ? 'AND t."createdAt" <= :dateTo' : ''}

                    GROUP BY
                        DATE_TRUNC(:timeUnit, t."createdAt" AT TIME ZONE 'UTC'),
                        t."HostCollectiveId",
                        t."kind",
                        t."hostCurrency",
                        t."isRefund",
                        t."type",
                        "isHost",
                        "expenseType"
                ),
                CombinedData AS (
                    SELECT
                        "date",
                        "HostCollectiveId",
                        "amountInHostCurrency",
                        "platformFeeInHostCurrency",
                        "hostFeeInHostCurrency",
                        "paymentProcessorFeeInHostCurrency",
                        "taxAmountInHostCurrency",
                        "netAmountInHostCurrency",
                        "kind",
                        "isRefund",
                        "hostCurrency",
                        "type",
                        "isHost",
                        "expenseType"
                    FROM
                        AggregatedTransactions
                    UNION ALL
                    SELECT
                        DATE_TRUNC(:timeUnit, "date" AT TIME ZONE 'UTC') AS "date",
                        "HostCollectiveId",
                        "amountInHostCurrency",
                        "platformFeeInHostCurrency",
                        "hostFeeInHostCurrency",
                        "paymentProcessorFeeInHostCurrency",
                        "taxAmountInHostCurrency",
                        "netAmountInHostCurrency",
                        "kind",
                        "isRefund",
                        "hostCurrency",
                        "type",
                        "isHost",
                        "expenseType"
                    FROM
                        "HostMonthlyTransactions"
                    WHERE
                        "HostCollectiveId" = :hostCollectiveId
                        ${args.dateTo ? 'AND "date" <= :dateTo' : ''}
                )
            SELECT
                "date",
                "isRefund",
                "isHost",
                "kind",
                "type",
                "expenseType",
                "hostCurrency",
                SUM("platformFeeInHostCurrency") AS "platformFeeInHostCurrency",
                SUM("hostFeeInHostCurrency") AS "hostFeeInHostCurrency",
                SUM("paymentProcessorFeeInHostCurrency") AS "paymentProcessorFeeInHostCurrency",
                SUM("taxAmountInHostCurrency") AS "taxAmountInHostCurrency",
                SUM("netAmountInHostCurrency") AS "netAmountInHostCurrency",
                SUM("amountInHostCurrency") AS "amountInHostCurrency"
            FROM
                CombinedData
            GROUP BY
                "date",
                "isRefund",
                "isHost",
                "kind",
                "type",
                "expenseType",
                "hostCurrency"
            ORDER BY
                "date";
          `;

          const queryResult = await sequelize.query(query, {
            replacements: {
              hostCollectiveId: host.id,
              timeUnit: args.timeUnit,
              dateTo: moment(args.dateTo).utc().toISOString(),
              refreshedAt,
            },
            type: QueryTypes.SELECT,
            raw: true,
          });

          const nodes = await getHostReportNodesFromQueryResult({
            queryResult,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            timeUnit: args.timeUnit,
            currency: host.currency,
          });

          return {
            timeUnit: args.timeUnit,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            nodes,
          };
        },
      },
      hostStats: {
        type: new GraphQLNonNull(GraphQLHostStats),
        args: {
          hostContext: {
            type: GraphQLHostContext,
            defaultValue: 'ALL',
          },
        },
        async resolve(host, args) {
          let collectiveIds: number[];

          const allHostedCollectiveIds = (await host.getHostedCollectives({ attributes: ['id'], raw: true })).map(
            ({ id }) => id,
          );

          if (args.hostContext === 'ALL') {
            collectiveIds = allHostedCollectiveIds;
          } else {
            const hostInternalChildren = (await host.getChildren({ attributes: ['id'], raw: true })).map(
              ({ id }) => id,
            );
            const hostInternalIds = [host.id, ...hostInternalChildren];
            if (args.hostContext === 'INTERNAL') {
              collectiveIds = hostInternalIds;
            } else if (args.hostContext === 'HOSTED') {
              collectiveIds = allHostedCollectiveIds.filter(collectiveId => !hostInternalIds.includes(collectiveId));
            }
          }
          return { host, collectiveIds };
        },
      },
      hostMetrics: {
        type: new GraphQLNonNull(GraphQLHostMetrics),
        deprecationReason: '2025-06-24: Low performance query, see if `hostStats` is sufficient',
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
            description: 'A collection of accounts for which the metrics should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'The start date of the time series',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'The end date of the time series',
          },
        },
        async resolve(host, args) {
          let collectiveIds;
          if (args.account) {
            const collectives = await fetchAccountsWithReferences(args.account, {
              attributes: ['id'],
            });
            collectiveIds = collectives.map(collective => collective.id);
          }
          const metrics = await host.getHostMetrics(args.dateFrom || args.from, args.dateTo || args.to, collectiveIds);
          const toAmount = value => ({ value, currency: host.currency });
          return mapValues(metrics, (value, key) => (key.includes('Percent') ? value : toAmount(value)));
        },
      },
      hostMetricsTimeSeries: {
        type: new GraphQLNonNull(GraphQLHostMetricsTimeSeries),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
            description: 'A collection of accounts for which the metrics should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'The start date of the time series',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'The end date of the time series',
          },
          timeUnit: {
            type: GraphQLTimeUnit,
            description:
              'The time unit of the time series (such as MONTH, YEAR, WEEK etc). If no value is provided this is calculated using the dateFrom and dateTo values.',
          },
        },
        async resolve(host, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, host) || 1);
          const collectiveIds = args.account && (await fetchAccountsIdsWithReference(args.account));
          return { host, collectiveIds, timeUnit, dateFrom, dateTo };
        },
      },
      metrics: hostMetricsField,
      hostExpensesReport: {
        type: GraphQLHostExpensesReports,
        description: 'EXPERIMENTAL (this may change or be removed)',
        args: {
          timeUnit: {
            type: GraphQLTimeUnit,
            defaultValue: 'MONTH',
          },
          dateFrom: {
            type: GraphQLDateTime,
          },
          dateTo: {
            type: GraphQLDateTime,
          },
        },
        resolve: async (host: Collective, args: { timeUnit: TimeUnit; dateFrom: Date; dateTo: Date }) => {
          if (args.timeUnit !== 'MONTH' && args.timeUnit !== 'QUARTER' && args.timeUnit !== 'YEAR') {
            throw new Error('Only monthly, quarterly and yearly reports are supported.');
          }

          const query = `
            WITH HostCollectiveIds AS (
              SELECT "id" FROM "Collectives"
              WHERE (
                 "id" = :hostCollectiveId
                OR ("ParentCollectiveId" = :hostCollectiveId AND "type" != 'VENDOR')
              ) AND "deletedAt" IS NULL
            )
            SELECT
              DATE_TRUNC(:timeUnit, e."createdAt" AT TIME ZONE 'UTC') AS "date",
              SUM(t."amountInHostCurrency") AS "amount",
              (SELECT "currency" FROM "Collectives" where id = :hostCollectiveId) as "currency",
              COUNT(e."id") AS "count",
              CASE
                  WHEN e."CollectiveId" IN (SELECT * FROM HostCollectiveIds) THEN TRUE ELSE FALSE
              END AS "isHost",
              e."AccountingCategoryId"

            FROM "Expenses" e
            JOIN "Transactions" t ON t."ExpenseId" = e.id

            WHERE e."HostCollectiveId" = :hostCollectiveId
            AND t."kind" = 'EXPENSE' AND t."type" = 'CREDIT' AND NOT t."isRefund" AND t."RefundTransactionId" IS NULL AND t."deletedAt" IS NULL
            AND e."status" = 'PAID'
            AND e."deletedAt" IS NULL
            ${args.dateFrom ? 'AND e."createdAt" >= :dateFrom' : ''}
            ${args.dateTo ? 'AND e."createdAt" <= :dateTo' : ''}

            GROUP BY "date", "isHost", e."AccountingCategoryId"
          `;

          const queryResult = await sequelize.query(query, {
            replacements: {
              hostCollectiveId: host.id,
              timeUnit: args.timeUnit,
              dateTo: moment(args.dateTo).utc().toISOString(),
              dateFrom: moment(args.dateFrom).utc().toISOString(),
            },
            type: QueryTypes.SELECT,
            raw: true,
          });

          return {
            timeUnit: args.timeUnit,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            nodes: queryResult,
          };
        },
      },
      hostContributionsReport: {
        type: GraphQLHostExpensesReports,
        description: 'EXPERIMENTAL (this may change or be removed)',
        args: {
          timeUnit: {
            type: GraphQLTimeUnit,
            defaultValue: 'MONTH',
          },
          dateFrom: {
            type: GraphQLDateTime,
          },
          dateTo: {
            type: GraphQLDateTime,
          },
        },
        resolve: async (host: Collective, args: { timeUnit: TimeUnit; dateFrom: Date; dateTo: Date }) => {
          if (args.timeUnit !== 'MONTH' && args.timeUnit !== 'QUARTER' && args.timeUnit !== 'YEAR') {
            throw new Error('Only monthly, quarterly and yearly reports are supported.');
          }

          const query = `
            WITH HostCollectiveIds AS (
              SELECT "id" FROM "Collectives"
              WHERE (
                "id" = :hostCollectiveId
                OR ("ParentCollectiveId" = :hostCollectiveId AND "type" != 'VENDOR')
              ) AND "deletedAt" IS NULL
            )
            SELECT
              DATE_TRUNC(:timeUnit, COALESCE(t."clearedAt", t."createdAt") AT TIME ZONE 'UTC') AS "date",
              SUM(t."amountInHostCurrency") AS "amount",
              (SELECT "currency" FROM "Collectives" where id = :hostCollectiveId) as "currency",
              COUNT(o."id") AS "count",
              CASE
                  WHEN o."CollectiveId" IN (SELECT * FROM HostCollectiveIds) THEN TRUE ELSE FALSE
              END AS "isHost",
              o."AccountingCategoryId"

            FROM "Transactions" t
            JOIN "Orders" o ON o.id = t."OrderId"

            WHERE t."HostCollectiveId" = :hostCollectiveId
            AND t."kind" in ('CONTRIBUTION', 'ADDED_FUNDS') AND t."type" = 'CREDIT' AND NOT t."isRefund" AND t."RefundTransactionId" IS NULL AND t."deletedAt" IS NULL
            ${args.dateFrom ? 'AND COALESCE(t."clearedAt", t."createdAt") >= :dateFrom' : ''}
            ${args.dateTo ? 'AND COALESCE(t."clearedAt", t."createdAt") <= :dateTo' : ''}

            GROUP BY "date", "isHost", o."AccountingCategoryId"
          `;

          const queryResult = await sequelize.query(query, {
            replacements: {
              hostCollectiveId: host.id,
              timeUnit: args.timeUnit,
              dateTo: args.dateTo ? moment(args.dateTo).utc().toISOString() : null,
              dateFrom: args.dateFrom ? moment(args.dateFrom).utc().toISOString() : null,
            },
            type: QueryTypes.SELECT,
            raw: true,
          });

          return {
            timeUnit: args.timeUnit,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            nodes: queryResult,
          };
        },
      },
      hostApplications: {
        type: new GraphQLNonNull(GraphQLHostApplicationCollection),
        description: 'Applications for this host',
        args: {
          ...CollectionArgs,
          searchTerm: {
            type: GraphQLString,
            description: 'Search term for collective tags, id, name, slug and description.',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
            description: 'Order of the results',
          },
          status: {
            type: GraphQLHostApplicationStatus,
            description: 'Filter applications by status',
          },
          lastCommentBy: {
            type: new GraphQLList(GraphQLLastCommentBy),
            description: 'Filter host applications by the last user-role who replied to them',
          },
        },
        resolve: async (host, args, req) => {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its applications');
          }

          const where = {};

          if (args.lastCommentBy?.length) {
            const conditions = [];
            const CollectiveIds = compact([
              args.lastCommentBy.includes('COLLECTIVE_ADMIN') && '"HostApplication"."CollectiveId"',
              args.lastCommentBy.includes('HOST_ADMIN') && `"collective"."HostCollectiveId"`,
            ]);

            // Collective Conditions
            if (CollectiveIds.length) {
              conditions.push(
                sequelize.literal(
                  `(SELECT "FromCollectiveId" FROM "Comments" WHERE "Comments"."HostApplicationId" = "HostApplication"."id" ORDER BY "Comments"."createdAt" DESC LIMIT 1)
                    IN (
                      SELECT "MemberCollectiveId" FROM "Members" WHERE
                      "role" = 'ADMIN' AND "deletedAt" IS NULL AND
                      "CollectiveId" IN (${CollectiveIds.join(',')})
                  )`,
                ),
              );
            }

            where[Op.and] = where[Op.and] || [];
            where[Op.and].push(conditions.length > 1 ? { [Op.or]: conditions } : conditions[0]);
          }

          where['HostCollectiveId'] = host.id;
          if (args.status) {
            where['status'] = args.status;
          }

          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['slug'],
            textFields: ['name', 'description', 'longDescription'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
            publicIdFields: [{ field: 'publicId', prefix: EntityShortIdPrefix.Collective }],
          });

          const { rows, count } = await models.HostApplication.findAndCountAll({
            order: [[args.orderBy.field, args.orderBy.direction]],
            where,
            limit: args.limit,
            offset: args.offset,
            include: [
              {
                model: models.Collective,
                as: 'collective',
                required: true,
                where: {
                  ...(args.status !== 'REJECTED' && {
                    HostCollectiveId: host.id,
                  }),
                  ...(searchTermConditions.length && { [Op.or]: searchTermConditions }),
                },
              },
            ],
          });

          return { totalCount: count, limit: args.limit, offset: args.offset, nodes: rows };
        },
      },
      pendingApplications: {
        type: new GraphQLNonNull(GraphQLHostApplicationCollection),
        description: 'Pending applications for this host',
        deprecationReason: '2023-08-25: Deprecated in favour of host.hostApplications(status: PENDING).',
        args: {
          ...CollectionArgs,
          searchTerm: {
            type: GraphQLString,
            description:
              'A term to search membership. Searches in collective tags, name, slug, members description and role.',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
            description: 'Order of the results',
          },
        },
        resolve: async (host, args, req) => {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its pending application');
          }

          const applyTypes = [CollectiveType.COLLECTIVE, CollectiveType.FUND];
          const where = { HostCollectiveId: host.id, approvedAt: null, type: { [Op.in]: applyTypes } };

          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['slug'],
            textFields: ['name', 'description', 'longDescription'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
            publicIdFields: [{ field: 'publicId', prefix: EntityShortIdPrefix.Collective }],
          });

          if (searchTermConditions.length) {
            where[Op.or] = searchTermConditions;
          }

          const result = await models.Collective.findAndCountAll({
            where,
            limit: args.limit,
            offset: args.offset,
            order: [[args.orderBy.field, args.orderBy.direction]],
          });

          // Link applications to collectives
          const collectiveIds = result.rows.map(collective => collective.id);
          const applications = await models.HostApplication.findAll({
            order: [['updatedAt', 'DESC']],
            where: {
              HostCollectiveId: host.id,
              status: 'PENDING',
              CollectiveId: collectiveIds ? { [Op.in]: collectiveIds } : undefined,
            },
          });
          const groupedApplications = keyBy(applications, 'CollectiveId');
          const nodes = result.rows.map(collective => {
            const application = groupedApplications[collective.id];
            if (application) {
              application.collective = collective;
              return application;
            } else {
              return { collective };
            }
          });

          return { totalCount: result.count, limit: args.limit, offset: args.offset, nodes };
        },
      },
      hostedVirtualCards: {
        type: new GraphQLNonNull(GraphQLVirtualCardCollection),
        args: {
          searchTerm: { type: GraphQLString, description: 'Search term (card name, card last four digits)' },
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
          state: { type: GraphQLString, defaultValue: null, deprecationReason: '2023-06-12: Please use status.' },
          status: { type: new GraphQLList(GraphQLVirtualCardStatusEnum) },
          orderBy: { type: GraphQLChronologicalOrderInput, defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE },
          merchantAccount: { type: GraphQLAccountReferenceInput, defaultValue: null },
          collectiveAccountIds: { type: new GraphQLList(GraphQLAccountReferenceInput), defaultValue: null },
          withExpensesDateFrom: {
            type: GraphQLDateTime,
            description: 'Returns virtual cards with expenses from this date.',
          },
          withExpensesDateTo: {
            type: GraphQLDateTime,
            description: 'Returns virtual cards with expenses to this date.',
          },
          spentAmountFrom: {
            type: GraphQLAmountInput,
            description: 'Filter virtual cards with at least this amount in cents charged',
          },
          spentAmountTo: {
            type: GraphQLAmountInput,
            description: 'Filter virtual cards with up to this amount in cents charged',
          },
          hasMissingReceipts: {
            type: GraphQLBoolean,
            description: 'Filter virtual cards by whether they are missing receipts for any charges',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its hosted virtual cards');
          }

          const hasStatusFilter = !isEmpty(args.status);
          const hasCollectiveFilter = !isEmpty(args.collectiveAccountIds);
          const hasMerchantFilter = !isNil(args.merchantId);

          const hasSpentFromFilter = !isNil(args.spentAmountFrom);
          const hasSpentToFilter = !isNil(args.spentAmountTo);
          const hasSpentFilter = hasSpentFromFilter || hasSpentToFilter;

          const hasExpenseFromDate = !isNil(args.withExpensesDateFrom);
          const hasExpenseToDate = !isNil(args.withExpensesDateTo);
          const hasExpensePeriodFilter = hasExpenseFromDate || hasExpenseToDate;
          const hasSearchTerm = !isNil(args.searchTerm) && args.searchTerm.length !== 0;
          const searchTerm = `%${args.searchTerm}%`;

          const baseQuery = `
            SELECT
              vc.* from "VirtualCards" vc
              ${ifStr(args.merchantId, 'LEFT JOIN "Expenses" e ON e."VirtualCardId" = vc.id AND e."deletedAt" IS NULL')}
              ${ifStr(
                hasSpentFilter || hasExpensePeriodFilter,
                `
                LEFT JOIN LATERAL (
                  SELECT
                    ${ifStr(hasSpentFilter, 'sum(ce.amount) as sum')}
                    ${ifStr(!hasSpentFilter, 'count(1) as count')}
                  FROM "Expenses" ce
                  WHERE ce."VirtualCardId" = vc.id
                  ${ifStr(hasExpenseFromDate, 'AND ce."createdAt" >= :expensesFromDate')}
                  ${ifStr(hasExpenseToDate, 'AND ce."createdAt" <= :expensesToDate')}
                  AND ce."deletedAt" IS NULL
                  ${ifStr(!hasSpentFilter, 'LIMIT 1')}
                ) AS charges ON TRUE
              `,
              )}
              ${ifStr(
                !isNil(args.hasMissingReceipts),
                `
                LEFT JOIN LATERAL (
                  SELECT count(1) as total FROM "Expenses" ce
                  LEFT JOIN "ExpenseItems" ei on ei."ExpenseId" = ce.id
                  WHERE ce."VirtualCardId" = vc.id
                  ${ifStr(hasExpenseFromDate, 'AND ce."createdAt" >= :expensesFromDate')}
                  ${ifStr(hasExpenseToDate, 'AND ce."createdAt" <= :expensesToDate')}
                  AND ei.url IS NULL
                  AND ei."deletedAt" is NULL
                  AND ce."deletedAt" is NULL
                  LIMIT 1
                ) AS "lackingReceipts" ON TRUE
              `,
              )}
            WHERE
              vc."HostCollectiveId" = :hostCollectiveId
              AND vc."deletedAt" IS NULL
              ${ifStr(hasStatusFilter, `AND vc.data#>>'{status}' IN (:status)`)}
              ${ifStr(hasCollectiveFilter, `AND vc."CollectiveId" IN (:collectiveIds)`)}
              ${ifStr(hasMerchantFilter, 'AND e."CollectiveId" = :merchantId')}

              ${ifStr(
                hasExpensePeriodFilter && !hasSpentFilter,
                `
              -- filter by existence of expenses
                AND COALESCE(charges.count, 0) > 0
              `,
              )}

              ${ifStr(
                hasSpentFromFilter,
                `
                -- filter by sum of expense amounts
                AND COALESCE(charges.sum, 0) >= :spentAmountFrom
              `,
              )}
              ${ifStr(
                hasSpentToFilter,
                `
                -- filter by sum of expense amounts
                AND COALESCE(charges.sum, 0) <= :spentAmountTo
              `,
              )}

              ${ifStr(args.hasMissingReceipts === true, `AND COALESCE("lackingReceipts".total, 0) > 0`)}
              ${ifStr(args.hasMissingReceipts === false, `AND COALESCE("lackingReceipts".total, 0) = 0`)}

              ${ifStr(
                hasSearchTerm,
                `AND (
                vc.name ILIKE :searchTerm
                OR vc.data#>>'{last4}' ILIKE :searchTerm
              )`,
              )}
          `;

          const countQuery = `
            SELECT count(1) as total FROM (${baseQuery}) as base
          `;

          const pageQuery = `
                SELECT * FROM (${baseQuery}) as base
                ORDER BY "createdAt" ${args.orderBy.direction === 'DESC' ? 'DESC' : 'ASC'}
                LIMIT :limit
                OFFSET :offset
          `;

          let merchantId;
          if (!isEmpty(args.merchantAccount)) {
            merchantId = (
              await fetchAccountWithReference(args.merchantAccount, { throwIfMissing: true, loaders: req.loaders })
            ).id;
          }

          const collectiveIds = isEmpty(args.collectiveAccountIds)
            ? [null]
            : await Promise.all(
                args.collectiveAccountIds.map(collectiveAccountId =>
                  fetchAccountWithReference(collectiveAccountId, { throwIfMissing: true, loaders: req.loaders }),
                ),
              ).then(collectives => collectives.map(collective => collective.id));

          const statusArg = !args.status || args.status.length === 0 ? [null] : args.status;

          const queryReplacements = {
            hostCollectiveId: host.id,
            status: statusArg,
            collectiveIds: collectiveIds,
            merchantId: merchantId ?? null,
            expensesFromDate: args.withExpensesDateFrom ?? null,
            expensesToDate: args.withExpensesDateTo ?? null,
            spentAmountFrom: args.spentAmountFrom ? getValueInCentsFromAmountInput(args.spentAmountFrom) : null,
            spentAmountTo: args.spentAmountTo ? getValueInCentsFromAmountInput(args.spentAmountTo) : null,
            limit: args.limit,
            offset: args.offset,
            hasMissingReceipts: args.hasMissingReceipts ?? null,
            searchTerm: searchTerm,
          };

          const nodes = () =>
            sequelize.query(pageQuery, {
              replacements: queryReplacements,
              type: QueryTypes.SELECT,
              model: models.VirtualCard,
            });

          const totalCount = () =>
            sequelize
              .query(countQuery, {
                plain: true,
                replacements: queryReplacements,
              })
              .then(result => result.total);

          return {
            nodes,
            totalCount,
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      hostedVirtualCardMerchants: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin to see the virtual card merchants');
          }

          const result = await models.Collective.findAndCountAll({
            group: 'Collective.id',
            where: {
              type: CollectiveType.VENDOR,
            },
            include: [
              {
                attributes: [],
                association: 'submittedExpenses',
                required: true,
                include: [
                  {
                    attributes: [],
                    association: 'virtualCard',
                    required: true,
                    where: {
                      HostCollectiveId: host.id,
                      data: { type: 'MERCHANT_LOCKED' },
                    },
                  },
                ],
              },
            ],
          });

          return {
            nodes: result.rows,
            totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      hostedVirtualCardCollectives: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin to see the virtual card merchants');
          }

          const result = await models.Collective.findAndCountAll({
            group: 'Collective.id',
            include: [
              {
                attributes: [],
                association: 'virtualCardCollectives',
                required: true,
                where: {
                  HostCollectiveId: host.id,
                },
              },
            ],
          });

          return {
            nodes: result.rows,
            totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      isTrustedHost: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Returns whether the host is trusted or not',
        resolve: account => get(account, 'data.isTrustedHost', false),
      },
      isFirstPartyHost: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Returns whether the host is a first party host',
        resolve: account => get(account, 'data.isFirstPartyHost', false),
      },
      hostedAccountAgreements: {
        type: new GraphQLNonNull(GraphQLAgreementCollection),
        description: 'Returns agreements with Hosted Accounts',
        args: {
          ...CollectionArgs,
          accounts: {
            type: new GraphQLList(GraphQLAccountReferenceInput),
            description: 'Filter by accounts participating in the agreement',
          },
        },
        async resolve(host, args, req) {
          if (!Agreement.canSeeAgreementsForHostCollectiveId(req.remoteUser, host.id)) {
            throw new Unauthorized(
              'You need to be logged in as an admin or accountant of the host to see its agreements',
            );
          }

          const includeWhereArgs = {};

          if (args.accounts && args.accounts.length > 0) {
            const accounts = await fetchAccountsWithReferences(args.accounts, {
              throwIfMissing: true,
              attributes: ['id', 'ParentCollectiveId'],
            });

            const allIds = accounts.map(account => account.id);
            const allParentIds = accounts.map(account => account.ParentCollectiveId).filter(Boolean);
            includeWhereArgs['id'] = uniq([...allIds, ...allParentIds]);
          }

          const agreements = await Agreement.findAndCountAll({
            where: {
              HostCollectiveId: host.id,
            },
            include: [
              {
                model: Collective,
                as: 'Collective',
                required: true,
                where: includeWhereArgs,
              },
            ],
            limit: args.limit,
            offset: args.offset,
            order: [['createdAt', 'desc']],
          });

          return { totalCount: agreements.count, limit: args.limit, offset: args.offset, nodes: agreements.rows };
        },
      },
      hostedAccounts: {
        type: new GraphQLNonNull(GraphQLHostedAccountCollection),
        description: 'Returns a list of accounts hosted by this host',
        args: {
          ...getCollectionArgs({ limit: 100, offset: 0 }),
          accountType: { type: new GraphQLList(GraphQLAccountType) },
          isApproved: {
            type: GraphQLBoolean,
            description: 'Filter on (un)approved collectives',
            defaultValue: true,
          },
          isFrozen: {
            type: GraphQLBoolean,
            description: 'Filter on frozen accounts',
          },
          isUnhosted: {
            type: GraphQLBoolean,
            description: 'Filter on unhosted accounts',
            defaultValue: false,
          },
          hostFeesStructure: {
            type: GraphQLHostFeeStructure,
            description: 'Filters on the Host fees structure applied to this account',
          },
          searchTerm: {
            type: GraphQLString,
            description:
              'A term to search membership. Searches in collective tags, name, slug, members description and role.',
          },
          orderBy: {
            type: GraphQLOrderByInput,
            description: 'Order of the results',
          },
          balance: {
            type: GraphQLAmountRangeInput,
            description: 'Filter by the balance of the account',
          },
          consolidatedBalance: {
            type: GraphQLAmountRangeInput,
            description: 'Filter by the balance of the account and its children accounts (events and projects)',
          },
          currencies: {
            type: new GraphQLList(GraphQLString),
            description: 'Filter by specific Account currencies',
          },
          startsAtFrom: {
            type: GraphQLDateTime,
            description: 'Filter for accounts (Events) that started at a specific date range',
          },
          startsAtTo: {
            type: GraphQLDateTime,
            description: 'Filter for accounts (Events) that started at a specific date range',
          },
          joinedBetween: {
            type: GraphQLMetricsDateRangeInput,
          },
          unhostedBetween: {
            type: GraphQLMetricsDateRangeInput,
          },
          hadActivityBetween: {
            type: GraphQLMetricsDateRangeInput,
          },
          noActivityBetween: {
            type: GraphQLMetricsDateRangeInput,
          },
        },
        async resolve(host, args) {
          const where: Parameters<typeof models.Collective.findAndCountAll>[0]['where'] = {
            HostCollectiveId: host.id,
            id: { [Op.not]: host.id },
            [Op.and]: [],
          };

          if (args.accountType && args.accountType.length > 0) {
            where.type = {
              [Op.in]: [...new Set(args.accountType.map(value => AccountTypeToModelMapping[value]))],
            };
          }

          if (args.currencies && args.currencies.length > 0) {
            where.currency = {
              [Op.in]: args.currencies,
            };
          }

          if (!isNil(args.isFrozen)) {
            if (args.isFrozen) {
              set(where, `data.features.${FEATURE.ALL}`, false);
            } else {
              set(where, `data.features.${FEATURE.ALL}`, { [Op.is]: null });
            }
          }

          if (args.hostFeesStructure) {
            if (args.hostFeesStructure === HOST_FEE_STRUCTURE.DEFAULT) {
              where.data = { useCustomHostFee: { [Op.not]: true } };
            } else if (args.hostFeesStructure === HOST_FEE_STRUCTURE.CUSTOM_FEE) {
              where.data = { useCustomHostFee: true };
            } else if (args.hostFeesStructure === HOST_FEE_STRUCTURE.MONTHLY_RETAINER) {
              throw new ValidationFailed('The MONTHLY_RETAINER fees structure is not supported yet');
            }
          }

          if (!isEmpty(args.balance)) {
            if (args.balance.gte?.currency) {
              assert(args.balance.gte.currency === host.currency, 'Balance currency must match host currency');
            }

            if (args.balance.lte?.currency) {
              assert(args.balance.lte.currency === host.currency, 'Balance currency must match host currency');
            }

            const { operator, value } = getAmountRangeValueAndOperator(args.balance);
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push(sequelize.where(ACCOUNT_BALANCE_QUERY, operator, value));
          }

          if (!isEmpty(args.consolidatedBalance)) {
            if (args.consolidatedBalance.gte?.currency) {
              assert(
                args.consolidatedBalance.gte.currency === host.currency,
                'Consolidated Balance currency must match host currency',
              );
            }

            if (args.consolidatedBalance.lte?.currency) {
              assert(
                args.consolidatedBalance.lte.currency === host.currency,
                'Consolidated Balance currency must match host currency',
              );
            }

            const { operator, value } = getAmountRangeValueAndOperator(args.consolidatedBalance);
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push(sequelize.where(ACCOUNT_CONSOLIDATED_BALANCE_QUERY, operator, value));
          }

          let metricCollectiveIds: number[] | null = null;
          const intersectMetricIds = (ids: number[]) => {
            if (metricCollectiveIds === null) {
              metricCollectiveIds = ids;
            } else {
              const set = new Set(ids);
              metricCollectiveIds = metricCollectiveIds.filter(id => set.has(id));
            }
          };
          const toIdNumbers = (values: Array<string | number>): number[] =>
            values.map(v => Number(v)).filter(n => Number.isFinite(n) && n > 0);
          if (args.joinedBetween) {
            intersectMetricIds(
              toIdNumbers(
                await listMatchingDimensionValues({
                  source: HostedCollectivesMembership,
                  dateFrom: args.joinedBetween.from,
                  dateTo: args.joinedBetween.to,
                  filters: { host: host.id, event: 'JOINED' },
                  dimension: 'account',
                }),
              ),
            );
          }
          if (args.unhostedBetween) {
            intersectMetricIds(
              toIdNumbers(
                await listMatchingDimensionValues({
                  source: HostedCollectivesMembership,
                  dateFrom: args.unhostedBetween.from,
                  dateTo: args.unhostedBetween.to,
                  filters: { host: host.id, event: 'CHURNED' },
                  dimension: 'account',
                }),
              ),
            );
          }
          if (args.hadActivityBetween) {
            intersectMetricIds(
              toIdNumbers(
                await listMatchingDimensionValues({
                  source: HostedCollectivesFinancialActivity,
                  dateFrom: args.hadActivityBetween.from,
                  dateTo: args.hadActivityBetween.to,
                  filters: { host: host.id },
                  // Roll children (events, projects) up to their parent
                  dimension: 'mainAccount',
                }),
              ),
            );
          }
          if (args.noActivityBetween) {
            const [hostedIds, activeIds] = await Promise.all([
              listMatchingDimensionValues({
                source: HostedCollectivesHostingPeriods,
                dateFrom: args.noActivityBetween.from,
                dateTo: args.noActivityBetween.to,
                filters: { host: host.id },
                dimension: 'account',
              }),
              listMatchingDimensionValues({
                source: HostedCollectivesFinancialActivity,
                dateFrom: args.noActivityBetween.from,
                dateTo: args.noActivityBetween.to,
                filters: { host: host.id },
                dimension: 'mainAccount',
              }),
            ]);
            const activeSet = new Set(toIdNumbers(activeIds));
            intersectMetricIds(toIdNumbers(hostedIds).filter(id => !activeSet.has(id)));
          }
          const isMetricScoped = metricCollectiveIds !== null;
          if (isMetricScoped) {
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push({ id: { [Op.in]: metricCollectiveIds } });
          } else if (args.isUnhosted) {
            const collectiveIds = await models.HostApplication.findAll({
              attributes: ['CollectiveId'],
              where: { HostCollectiveId: host.id, status: 'APPROVED' },
            });
            where.HostCollectiveId = { [Op.or]: [{ [Op.ne]: host.id }, { [Op.is]: null }] };
            const id = collectiveIds.map(({ CollectiveId }) => CollectiveId);
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            if (!where[Op.and]) {
              // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
              where[Op.and] = [];
            }
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push({ [Op.or]: [{ id: id }, { ParentCollectiveId: id }] });
          } else {
            where.isActive = true;
            where.approvedAt = args.isApproved ? { [Op.not]: null } : null;
          }

          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['slug'],
            textFields: ['name', 'description'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
            castStringArraysToVarchar: true,
            publicIdFields: [{ field: 'publicId', prefix: EntityShortIdPrefix.Collective }],
          });

          if (searchTermConditions.length) {
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.or] = searchTermConditions;
          }

          if (args.startsAtFrom) {
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push({ startsAt: { [Op.gte]: args.startsAtFrom } });
          }
          if (args.startsAtTo) {
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push({ startsAt: { [Op.lte]: args.startsAtTo } });
          }

          const orderBy = [];
          if (args.orderBy) {
            const { field, direction } = args.orderBy;
            if (field === ORDER_BY_PSEUDO_FIELDS.CREATED_AT) {
              // Quick hack here, using ApprovedAt because in this context,
              // it doesn't make sense to order by createdAt and this ends
              // up saving a whole new component that needs to be implemented
              orderBy.push(['approvedAt', direction]);
            } else if (field === ORDER_BY_PSEUDO_FIELDS.BALANCE) {
              orderBy.push([ACCOUNT_CONSOLIDATED_BALANCE_QUERY, direction]);
            } else if (field === ORDER_BY_PSEUDO_FIELDS.UNHOSTED_AT) {
              orderBy.push([
                sequelize.literal(
                  `(SELECT "Activities"."createdAt" FROM "Activities" WHERE "CollectiveId" = "Collective"."id" AND "Activities"."HostCollectiveId" = ${host.id} AND "Activities"."type" = '${ActivityTypes.COLLECTIVE_UNHOSTED}' ORDER BY "Activities"."id" DESC LIMIT 1)`,
                ),
                direction,
              ]);
            } else if (field === ORDER_BY_PSEUDO_FIELDS.STARTS_AT) {
              where['startsAt'] = { [Op.not]: null };
              orderBy.push(['startsAt', direction]);
            } else {
              orderBy.push([field, direction]);
            }
          } else {
            orderBy.push(['approvedAt', 'DESC']);
          }

          const result = await models.Collective.findAndCountAll({
            limit: args.limit,
            offset: args.offset,
            order: orderBy,
            where,
          });

          return {
            nodes: result.rows,
            totalCount: result.count,
            limit: args.limit,
            offset: args.offset,
            currencies: () =>
              models.Collective.findAll({
                where,
                attributes: [[sequelize.fn('DISTINCT', sequelize.col('currency')), 'currency']],
              }).then(collectives => collectives.map(c => c.currency)),
          };
        },
      },
      hostedLegalDocuments: {
        type: new GraphQLNonNull(GraphQLLegalDocumentCollection),
        description: 'Returns legal documents hosted by this host',
        args: {
          ...CollectionArgs,
          type: {
            type: new GraphQLList(GraphQLLegalDocumentType),
            description: 'Filter by type of legal document',
          },
          status: {
            type: new GraphQLList(GraphQLLegalDocumentRequestStatus),
            description: 'Filter by status of legal document',
          },
          account: {
            type: new GraphQLList(GraphQLAccountReferenceInput),
            description: 'Filter by accounts',
          },
          searchTerm: {
            type: GraphQLString,
            description: 'Search term (name, description, ...)',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            description: 'The order of results',
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
          },
          requestedAtFrom: {
            type: GraphQLDateTime,
            description: 'Filter by requested date from',
          },
          requestedAtTo: {
            type: GraphQLDateTime,
            description: 'Filter by requested date to',
          },
        },
        resolve: async (host, args, req) => {
          checkRemoteUserCanUseHost(req);
          if (!req.remoteUser.isAdminOfCollective(host)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its legal documents');
          }

          if (args.type?.length > 1 || args.type?.[0] !== LEGAL_DOCUMENT_TYPE.US_TAX_FORM) {
            throw new Error('Only US_TAX_FORM is supported for now');
          }

          const { offset, limit } = args;
          const accountIds = await SQLQueries.getTaxFormsRequiredForAccounts({
            HostCollectiveId: host.id,
            allTime: true,
          });
          if (!accountIds.size) {
            return { nodes: [], totalCount: 0, limit, offset };
          }

          const where = { CollectiveId: Array.from(accountIds) };
          if (args.type) {
            where['documentType'] = args.type;
          }
          if (args.status) {
            where['requestStatus'] = args.status;
          }

          if (args.account && args.account.length > 0) {
            const accountIds = await fetchAccountsIdsWithReference(args.account, { throwIfMissing: true });
            where['CollectiveId'] = uniq(accountIds);
          }

          if (args.requestedAtFrom) {
            where['createdAt'] = { [Op.gte]: args.requestedAtFrom };
          }
          if (args.requestedAtTo) {
            where['createdAt'] = { ...where['createdAt'], [Op.lte]: args.requestedAtTo };
          }

          const include = [];

          // Add support for text search
          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id', 'CollectiveId'],
            slugFields: ['$collective.slug$'],
            textFields: ['$collective.name$'],
            publicIdFields: [
              { field: 'publicId', prefix: EntityShortIdPrefix.LegalDocument },
              { field: '$collective.publicId$', prefix: EntityShortIdPrefix.Collective },
            ],
          });

          if (searchTermConditions.length) {
            where[Op.or] = searchTermConditions;
            include.push({ association: 'collective', required: true });
          }

          return {
            totalCount: () => models.LegalDocument.count({ where, include }),
            nodes: () =>
              models.LegalDocument.findAll({
                where,
                offset,
                include,
                limit,
                order: [
                  [args.orderBy.field, args.orderBy.direction],
                  ['id', 'DESC'],
                ],
              }),
            limit,
            offset,
          };
        },
      },
      ...mapValues(
        pick(getOrganizationFields(), [
          'location',
          'accountingCategories',
          'contributionAccountingCategoryRules',
          'hasMoneyManagement',
          'supportedPayoutMethods',
          'manualPaymentProviders',
          'paypalClientId',
          'supportedPaymentMethods',
          'stripe',
          'contributionStats',
          'expenseStats',
          'allowAddFundsFromAllAccounts',
          'hasDisputedOrders',
          'hasInReviewOrders',
          'vendors',
          'potentialVendors',
          'requiredLegalDocuments',
          'transactionsImports',
          'transactionsImportsSources',
          'offPlatformTransactions',
          'offPlatformTransactionsStats',
        ]),
        value => ({
          ...value,
          deprecationReason: '2026-04-22: This field has moved to the Organization type',
        }),
      ),
    };
  },
});
