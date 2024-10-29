import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { get, has, intersection, pick } from 'lodash';
import moment from 'moment';

import { TransactionKind } from '../../../constants/transaction-kind';
import { getCollectiveIds } from '../../../lib/budget';
import queries from '../../../lib/queries';
import sequelize, { QueryTypes } from '../../../lib/sequelize';
import { computeDatesAsISOStrings } from '../../../lib/utils';
import models from '../../../models';
import { GraphQLContributionFrequency } from '../enum/ContributionFrequency';
import { GraphQLCurrency } from '../enum/Currency';
import { GraphQLExpenseType } from '../enum/ExpenseType';
import { GraphQLTransactionKind } from '../enum/TransactionKind';
import { idEncode } from '../identifiers';
import { GraphQLAmount } from '../object/Amount';
import { GraphQLAmountStats } from '../object/AmountStats';
import { getNumberOfDays, getTimeUnit, GraphQLTimeSeriesAmount, TimeSeriesArgs } from '../object/TimeSeriesAmount';

const { ADDED_FUNDS, CONTRIBUTION } = TransactionKind;

const TransactionArgs = {
  net: {
    type: GraphQLBoolean,
    description: 'Return the net amount (with payment processor fees removed)',
    defaultValue: false,
  },
  kind: {
    type: new GraphQLList(GraphQLTransactionKind),
    description: 'Filter by kind',
  },
  periodInMonths: {
    type: GraphQLInt,
    description: 'Calculate amount for the last x months. Cannot be used with startDate/endDate',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Calculate amount after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Calculate amount before this date',
  },
  includeChildren: {
    type: GraphQLBoolean,
    description: 'Include transactions from children (Projects and Events)',
    defaultValue: false,
  },
  currency: {
    type: GraphQLCurrency,
    description: 'An optional currency. If not provided, will use the collective currency.',
  },
};

export const GraphQLAccountStats = new GraphQLObjectType({
  name: 'AccountStats',
  description: 'Stats for the Account',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        resolve(collective) {
          return idEncode(collective.id);
        },
      },
      balanceWithBlockedFunds: {
        description: 'Amount of money in cents in the currency of the collective currently available to spend',
        deprecationReason: '2022-12-13: Use balance + withBlockedFunds instead',
        type: new GraphQLNonNull(GraphQLAmount),
        resolve(account, args, req) {
          return account.getBalanceAmount({ loaders: req.loaders, withBlockedFunds: true });
        },
      },
      balance: {
        description: 'Amount of money in cents in the currency of the collective',
        type: new GraphQLNonNull(GraphQLAmount),
        args: {
          ...pick(TransactionArgs, ['dateTo', 'includeChildren', 'currency']),
          withBlockedFunds: {
            type: GraphQLBoolean,
            description: 'Remove blocked funds from the balance',
            defaultValue: false,
          },
        },
        resolve(account, args, req) {
          return account.getBalanceAmount({
            loaders: req.loaders,
            endDate: args.dateTo,
            includeChildren: args.includeChildren,
            withBlockedFunds: args.withBlockedFunds,
            currency: args.currency,
          });
        },
      },
      consolidatedBalance: {
        description: 'The consolidated amount of all the events and projects combined.',
        deprecationReason: '2022-09-02: Use balance + includeChildren instead',
        type: new GraphQLNonNull(GraphQLAmount),
        resolve(account, args, req) {
          return account.getBalanceAmount({
            loaders: req.loaders,
            includeChildren: true,
          });
        },
      },
      monthlySpending: {
        description: 'Average amount spent per month based on the last 90 days',
        type: new GraphQLNonNull(GraphQLAmount),
        async resolve(collective) {
          // if we fetched the collective with the raw query to sort them by their monthly spending we don't need to recompute it
          if (has(collective, 'dataValues.monthlySpending')) {
            return {
              value: get(collective, 'dataValues.monthlySpending'),
              currency: collective.currency,
            };
          } else {
            return {
              value: await collective.getMonthlySpending(),
              currency: collective.currency,
            };
          }
        },
      },
      totalAmountSpent: {
        description: 'Total amount spent',
        type: new GraphQLNonNull(GraphQLAmount),
        args: {
          ...pick(TransactionArgs, [
            'net',
            'kind',
            'dateFrom',
            'dateTo',
            'periodInMonths',
            'includeChildren',
            'currency',
          ]),
          includeGiftCards: {
            type: GraphQLBoolean,
            description: 'Include transactions using Gift Cards (not working together with includeChildren)',
            defaultValue: false,
          },
        },
        async resolve(collective, args, req) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
          }

          return collective.getTotalAmountSpentAmount({
            loaders: req.loaders,
            net: args.net,
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
            includeGiftCards: args.includeChildren ? false : args.includeGiftCards,
            currency: args.currency,
          });
        },
      },
      totalAmountReceived: {
        description: 'Total amount received',
        type: new GraphQLNonNull(GraphQLAmount),
        args: {
          ...pick(TransactionArgs, [
            'net',
            'kind',
            'dateFrom',
            'dateTo',
            'periodInMonths',
            'includeChildren',
            'currency',
          ]),
          useCache: {
            type: new GraphQLNonNull(GraphQLBoolean),
            description: 'Set this to true to use cached data',
            deprecationReason: '2022-12-14: this is not used anymore as results should be fast by default',
            defaultValue: false,
          },
        },
        async resolve(collective, args, req) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
          }

          return collective.getTotalAmountReceivedAmount({
            loaders: req.loaders,
            net: args.net,
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
            currency: args.currency,
          });
        },
      },
      totalAmountReceivedTimeSeries: {
        description: 'Total amount received time series',
        type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
        args: {
          ...TimeSeriesArgs, // dateFrom / dateTo / timeUnit
          ...pick(TransactionArgs, ['net', 'kind', 'periodInMonths', 'includeChildren', 'currency']),
        },
        async resolve(collective, args, req) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
          }

          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, collective) || 1);

          return collective.getTotalAmountReceivedTimeSeries({
            loaders: req.loaders,
            net: args.net,
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            timeUnit,
            includeChildren: args.includeChildren,
            currency: args.currency,
          });
        },
      },
      balanceTimeSeries: {
        description: 'Balance time series',
        type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
        args: {
          ...TimeSeriesArgs, // dateFrom / dateTo / timeUnit
          ...pick(TransactionArgs, ['net', 'kind', 'periodInMonths', 'includeChildren', 'currency']),
        },
        async resolve(collective, args, req) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
          }

          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, collective) || 1);

          return collective.getBalanceTimeSeries({
            loaders: req.loaders,
            net: args.net,
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            timeUnit,
            includeChildren: args.includeChildren,
            currency: args.currency,
          });
        },
      },
      totalPaidExpenses: {
        description: 'Total of paid expenses to the account, filter per expense type',
        type: new GraphQLNonNull(GraphQLAmount),
        args: {
          ...pick(TransactionArgs, ['dateFrom', 'dateTo', 'currency']),
          expenseType: {
            type: new GraphQLList(GraphQLExpenseType),
            description: 'Filter by ExpenseType',
          },
        },
        async resolve(collective, args) {
          return collective.getTotalPaidExpensesAmount({
            startDate: args.dateFrom,
            endDate: args.dateTo,
            currency: args.currency,
            expenseType: args.expenseType,
          });
        },
      },
      yearlyBudget: {
        type: new GraphQLNonNull(GraphQLAmount),
        async resolve(collective, args, req) {
          return collective.getYearlyBudgetAmount({ loaders: req.loaders });
        },
      },
      yearlyBudgetManaged: {
        type: new GraphQLNonNull(GraphQLAmount),
        deprecationReason: '2023-03-01: This field will be removed soon, please use totalMoneyManaged',
        async resolve(collective) {
          if (collective.isHostAccount) {
            return {
              value: await queries.getTotalAnnualBudgetForHost(collective.id),
              currency: collective.currency,
            };
          } else {
            return {
              value: 0,
              currency: collective.currency,
            };
          }
        },
      },
      totalNetAmountReceived: {
        description: 'Total net amount received',
        deprecationReason: '2022-12-13: Use totalAmountReceived + net=true instead',
        type: new GraphQLNonNull(GraphQLAmount),
        args: {
          ...pick(TransactionArgs, ['kind', 'dateFrom', 'dateTo', 'periodInMonths', 'includeChildren']),
        },
        async resolve(collective, args, req) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
          }
          return collective.getTotalAmountReceivedAmount({
            loaders: req.loaders,
            net: true,
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
          });
        },
      },
      totalNetAmountReceivedTimeSeries: {
        description: 'Total net amount received time series',
        deprecationReason: '2022-12-13: Use totalAmountReceivedTimeSeries + net=true instead',
        type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
        args: {
          ...TimeSeriesArgs, // dateFrom / dateTo / timeUnit
          ...pick(TransactionArgs, ['kind', 'periodInMonths', 'includeChildren', 'currency']),
        },
        async resolve(collective, args, req) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
          }
          return collective.getTotalAmountReceivedTimeSeries({
            loaders: req.loaders,
            net: true,
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            timeUnit: args.timeUnit,
            includeChildren: args.includeChildren,
            currency: args.currency,
          });
        },
      },
      activeRecurringContributions: {
        type: GraphQLJSON,
        deprecationReason: '2022-10-21: Use activeRecurringContributionsV2 while we migrate to better semantics.',
        resolve(collective, args, req) {
          const loader = req.loaders.Collective.stats.activeRecurringContributions.buildLoader({
            currency: collective.currency,
          });
          return loader.load(collective.id);
        },
      },
      activeRecurringContributionsV2: {
        type: GraphQLAmount,
        deprecationReason:
          '2024-03-04: Use activeRecurringContributionsBreakdown while we migrate to better semantics.',
        args: {
          frequency: {
            type: new GraphQLNonNull(GraphQLContributionFrequency),
            description: 'The frequency of the recurring contribution (MONTHLY or YEARLY)',
            defaultValue: 'MONTHLY',
          },
        },
        async resolve(collective, args, req) {
          const key = args.frequency.toLowerCase();
          if (!['monthly', 'yearly'].includes(key)) {
            throw new Error('Unsupported frequency.');
          }
          const loader = req.loaders.Collective.stats.activeRecurringContributions.buildLoader({
            currency: collective.currency,
          });
          const stats = await loader.load(collective.id);
          return {
            value: stats[key],
            currency: collective.currency,
          };
        },
      },
      activeRecurringContributionsBreakdown: {
        description: 'Returns some statistics about active recurring contributions, broken down by frequency',
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAmountStats))),
        args: {
          frequency: {
            type: GraphQLContributionFrequency,
            description: 'Return only the stats for this frequency',
          },
          includeChildren: {
            type: GraphQLBoolean,
            description: 'Include contributions to children accounts (Projects and Events)',
            defaultValue: false,
          },
        },
        async resolve(collective, args, req) {
          const interval = args.frequency?.toLowerCase();
          if (interval && !['monthly', 'yearly'].includes(interval)) {
            throw new Error('Unsupported frequency.');
          }
          const currency = collective.currency;
          const loader = req.loaders.Collective.stats.activeRecurringContributions.buildLoader({
            includeChildren: args.includeChildren,
            currency,
          });
          const stats = await loader.load(collective.id);
          const getStatsForInterval = interval => ({
            label: interval,
            count: stats[`${interval}Count`],
            amount: stats[interval],
            currency,
          });

          if (interval) {
            return [getStatsForInterval(interval)];
          } else {
            return ['monthly', 'yearly'].map(getStatsForInterval);
          }
        },
      },
      expensesTags: {
        type: new GraphQLList(GraphQLAmountStats),
        description: 'Returns expense tags for collective sorted by popularity',
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          truncate: { type: GraphQLInt, defaultValue: 7 },
          ...pick(TransactionArgs, ['dateFrom', 'dateTo', 'includeChildren']),
        },
        async resolve(collective, args) {
          const limit = args.limit;
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const includeChildren = args.includeChildren;
          const tags = await models.Expense.getCollectiveExpensesTags(collective, {
            limit,
            dateFrom,
            dateTo,
            includeChildren,
          });

          return tags.reduce((acc, t, i) => {
            if (i < args.truncate - 1) {
              return [...acc, t];
            } else {
              if (!acc[args.truncate - 1]) {
                acc[args.truncate - 1] = { label: 'OTHERS_COMBINED', amount: 0, count: 0, currency: t.currency };
              }
              acc[args.truncate - 1].amount += t.amount;
              acc[args.truncate - 1].count += t.count;
              return acc;
            }
          }, []);
        },
      },
      expensesTagsTimeSeries: {
        type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
        args: {
          ...TimeSeriesArgs, // dateFrom / dateTo / timeUnit
          includeChildren: TransactionArgs.includeChildren,
        },
        description: 'History of the expense tags used by this collective.',
        resolve: async (collective, args) => {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : moment(collective.createdAt || new Date(2015, 1, 1));
          const dateTo = args.dateTo ? moment(args.dateTo) : moment();
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, collective) || 1);
          const includeChildren = args.includeChildren;
          const results = await models.Expense.getCollectiveExpensesTagsTimeSeries(collective, timeUnit, {
            dateFrom,
            dateTo,
            includeChildren,
          });
          return {
            dateFrom,
            dateTo,
            timeUnit,
            nodes: results.map(result => ({
              date: result.date,
              amount: { value: result.amount, currency: result.currency },
              label: result.label,
            })),
          };
        },
      },
      contributionsCount: {
        type: new GraphQLNonNull(GraphQLInt),
        args: {
          ...pick(TransactionArgs, ['dateFrom', 'dateTo', 'includeChildren']),
        },
        async resolve(collective, args, req) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;

          const { contributionsCount } = await collective.getContributionsAndContributorsCount({
            loaders: req.loaders,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
          });
          return contributionsCount;
        },
      },
      contributorsCount: {
        type: new GraphQLNonNull(GraphQLInt),
        args: {
          ...pick(TransactionArgs, ['dateFrom', 'dateTo', 'includeChildren']),
        },
        async resolve(collective, args, req) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;

          const { contributorsCount } = await collective.getContributionsAndContributorsCount({
            loaders: req.loaders,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
          });
          return contributorsCount;
        },
      },
      contributionsAmount: {
        type: new GraphQLList(GraphQLAmountStats),
        description: 'Return amount stats for contributions (default, and only for now: one-time vs recurring)',
        args: {
          ...pick(TransactionArgs, ['dateFrom', 'dateTo', 'includeChildren', 'kind']),
        },
        async resolve(collective, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const collectiveIds = await getCollectiveIds(collective, args.includeChildren);
          const kinds = args.kind ? intersection(args.kind, [CONTRIBUTION, ADDED_FUNDS]) : [CONTRIBUTION];
          return sequelize.query(
            `
            SELECT
              (CASE WHEN o."SubscriptionId" IS NOT NULL THEN 'recurring' ELSE 'one-time' END) as "label",
              COUNT(DISTINCT o."id") as "count",
              ABS(SUM(t."amount")) as "amount",
              t."currency"
            FROM "Orders" o
            INNER JOIN "Transactions" t ON t."OrderId" = o."id"
              AND t."deletedAt" IS NULL
              AND t."RefundTransactionId" IS NULL
            WHERE o."deletedAt" IS NULL
              AND o."CollectiveId" IN (:collectiveIds)
              AND o."FromCollectiveId" NOT IN (:collectiveIds)
              AND t."type" = 'CREDIT'
              AND t."kind" IN (:kinds)
              ${dateFrom ? `AND t."createdAt" >= :startDate` : ``}
              ${dateTo ? `AND t."createdAt" <= :endDate` : ``}
            GROUP BY "label", t."currency"
            ORDER BY ABS(SUM(t."amount")) DESC
            `,
            {
              type: QueryTypes.SELECT,
              replacements: {
                collectiveIds,
                kinds,
                ...computeDatesAsISOStrings(dateFrom, dateTo),
              },
            },
          );
        },
      },
      contributionsAmountTimeSeries: {
        type: new GraphQLNonNull(GraphQLTimeSeriesAmount),
        description: 'Return amount time series for contributions (default, and only for now: one-time vs recurring)',
        args: {
          ...TimeSeriesArgs, // dateFrom / dateTo / timeUnit
          includeChildren: TransactionArgs.includeChildren,
          kind: TransactionArgs.kind,
        },
        async resolve(collective, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : moment(collective.createdAt || new Date(2015, 1, 1));
          const dateTo = args.dateTo ? moment(args.dateTo) : moment();
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, collective) || 1);
          const collectiveIds = await getCollectiveIds(collective, args.includeChildren);
          const kinds = args.kind ? intersection(args.kind, [CONTRIBUTION, ADDED_FUNDS]) : [CONTRIBUTION];
          const results = await sequelize.query(
            `
            SELECT
              DATE_TRUNC(:timeUnit, t."createdAt") AS "date",
              (CASE WHEN o."SubscriptionId" IS NOT NULL THEN 'recurring' ELSE 'one-time' END) as "label",
              ABS(SUM(t."amount")) as "amount",
              t."currency"
            FROM "Orders" o
            INNER JOIN "Transactions" t ON t."OrderId" = o."id"
              AND t."deletedAt" IS NULL
              AND t."RefundTransactionId" IS NULL
            WHERE o."deletedAt" IS NULL
              AND o."CollectiveId" IN (:collectiveIds)
              AND o."FromCollectiveId" NOT IN (:collectiveIds)
              AND t."type" = 'CREDIT'
              AND t."kind" = 'CONTRIBUTION'
              ${dateFrom ? `AND t."createdAt" >= :startDate` : ``}
              ${dateTo ? `AND t."createdAt" <= :endDate` : ``}
            GROUP BY "date", "label", t."currency"
            ORDER BY "date", ABS(SUM(t."amount")) DESC
            `,
            {
              type: QueryTypes.SELECT,
              replacements: {
                collectiveIds,
                timeUnit,
                kinds,
                ...computeDatesAsISOStrings(dateFrom, dateTo),
              },
            },
          );
          return {
            dateFrom,
            dateTo,
            timeUnit,
            nodes: results.map(result => ({
              date: result.date,
              amount: { value: result.amount, currency: result.currency },
              label: result.label,
            })),
          };
        },
      },
    };
  },
});
