import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-type-json';
import { get, has, isNil } from 'lodash';
import moment from 'moment';

import queries from '../../../lib/queries';
import sequelize, { QueryTypes } from '../../../lib/sequelize';
import { computeDatesAsISOStrings } from '../../../lib/utils';
import models from '../../../models';
import { Currency } from '../enum/Currency';
import { ExpenseType } from '../enum/ExpenseType';
import { TransactionKind } from '../enum/TransactionKind';
import { idEncode } from '../identifiers';
import { Amount } from '../object/Amount';
import { AmountStats } from '../object/AmountStats';
import { getNumberOfDays, getTimeUnit, TimeSeriesAmount, TimeSeriesArgs } from '../object/TimeSeriesAmount';

export const AccountStats = new GraphQLObjectType({
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
        type: new GraphQLNonNull(Amount),
        resolve(account, args, req) {
          return account.getBalanceWithBlockedFundsAmount({ loaders: req.loaders });
        },
      },
      balance: {
        description: 'Amount of money in cents in the currency of the collective',
        type: new GraphQLNonNull(Amount),
        args: {
          dateFrom: {
            type: GraphQLDateTime,
            description: 'Calculate balance beginning from this date.',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'Calculate balance until this date.',
          },
        },
        resolve(account, args, req) {
          return account.getBalanceAmount({ loaders: req.loaders, startDate: args.dateFrom, endDate: args.dateTo });
        },
      },
      consolidatedBalance: {
        description: 'The consolidated amount of all the events and projects combined.',
        type: new GraphQLNonNull(Amount),
        resolve(account, args, req) {
          return account.getConsolidatedBalanceAmount({ loaders: req.loaders });
        },
      },
      monthlySpending: {
        description: 'Average amount spent per month based on the last 90 days',
        type: new GraphQLNonNull(Amount),
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
        type: new GraphQLNonNull(Amount),
        async resolve(collective) {
          return {
            value: await collective.getTotalAmountSpent(),
            currency: collective.currency,
          };
        },
      },
      totalAmountReceived: {
        description: 'Net amount received',
        type: new GraphQLNonNull(Amount),
        args: {
          kind: {
            type: new GraphQLList(TransactionKind),
            description: 'Filter by kind',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'Calculate total amount received before this date',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'Calculate total amount received after this date',
          },
          periodInMonths: {
            type: GraphQLInt,
            description: 'Computes contributions from the last x months. Cannot be used with startDate/endDate',
          },
          useCache: {
            type: new GraphQLNonNull(GraphQLBoolean),
            description: 'Set this to true to use cached data',
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

          // Search query joins "CollectiveTransactionStats" on this field, so we can use the cache
          if (args.useCache && !dateFrom && !dateTo) {
            const cachedAmount = collective.dataValues['__stats_totalAmountReceivedInHostCurrency__'];
            if (!isNil(cachedAmount)) {
              const host = collective.HostCollectiveId && (await req.loaders.Collective.host.load(collective.id));
              if (!host?.currency || host.currency === collective.currency) {
                return { value: cachedAmount, currency: collective.currency };
              }

              return {
                currency: collective.currency,
                value: await req.loaders.CurrencyExchangeRate.convert.load({
                  amount: cachedAmount,
                  fromCurrency: host.currency,
                  toCurrency: collective.currency,
                }),
              };
            }
          }

          return collective.getTotalAmountReceivedAmount({ kind, startDate: dateFrom, endDate: dateTo });
        },
      },
      totalPaidExpenses: {
        description: 'Total of paid expenses, filter per expensetype',
        type: new GraphQLNonNull(Amount),
        args: {
          expenseType: {
            type: new GraphQLList(ExpenseType),
            description: 'Filter by ExpenseType',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'Calculate total amount received before this date',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'Calculate total amount received after this date',
          },
          currency: {
            type: Currency,
            description: 'An optional currency. If not provided, will use the collective currency.',
          },
        },
        async resolve(collective, args) {
          return collective.getTotalPaidExpensesAmount({
            startDate: args.dateFrom,
            endDate: args.dateTo,
            expenseType: args.expenseType,
            currency: args.currency,
          });
        },
      },
      yearlyBudget: {
        type: new GraphQLNonNull(Amount),
        async resolve(collective) {
          return {
            value: await collective.getYearlyIncome(),
            currency: collective.currency,
          };
        },
      },
      yearlyBudgetManaged: {
        type: new GraphQLNonNull(Amount),
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
        type: new GraphQLNonNull(Amount),
        async resolve(collective) {
          const value = await collective.getTotalNetAmountReceived();
          return { value, currency: collective.currency };
        },
      },
      activeRecurringContributions: {
        type: GraphQLJSON,
        resolve(collective, args, req) {
          return req.loaders.Collective.stats.activeRecurringContributions.load(collective.id);
        },
      },
      expensesTags: {
        type: new GraphQLList(AmountStats),
        description: 'Returns expense tags for collective sorted by popularity',
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 30 },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'The start date of the time series',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'The end date of the time series',
          },
        },
        async resolve(collective, args) {
          const limit = args.limit;
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          return models.Expense.getCollectiveExpensesTags(collective, { limit, dateFrom, dateTo });
        },
      },
      expensesTagsTimeSeries: {
        type: new GraphQLNonNull(TimeSeriesAmount),
        args: {
          ...TimeSeriesArgs,
        },
        description: 'History of the expense tags used by this collective.',
        resolve: async (collective, args) => {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, collective) || 1);
          const results = await models.Expense.getCollectiveExpensesTagsTimeSeries(collective, timeUnit, {
            dateFrom,
            dateTo,
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
      contributionsAmount: {
        type: new GraphQLList(AmountStats),
        description: 'Return amount stats for contributions (default, and only for now: one-time vs recurring)',
        args: {
          dateFrom: {
            type: GraphQLDateTime,
            description: 'The start date of the time series',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'The end date of the time series',
          },
        },
        async resolve(collective, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          return sequelize.query(
            `
            SELECT
            (CASE WHEN o."SubscriptionId" IS NOT NULL THEN 'recurring' ELSE 'one-time' END) as "label",
            COUNT(o."id") as "count",
            ABS(SUM(t."amount")) as "amount",
            t."currency"
            FROM "Transactions" t
            LEFT JOIN "Orders" o
            ON t."OrderId" = o."id"
            WHERE t."type" = 'CREDIT'
            AND t."kind" = 'CONTRIBUTION'
            AND t."CollectiveId" = $collectiveId
            AND t."RefundTransactionId" IS NULL
            AND t."deletedAt" IS NULL
            ${dateFrom ? `AND t."createdAt" >= $startDate` : ``}
            ${dateTo ? `AND t."createdAt" <= $endDate` : ``}
            GROUP BY (CASE WHEN o."SubscriptionId" IS NOT NULL THEN 'recurring' ELSE 'one-time' END), t."currency"
            ORDER BY ABS(SUM(t."amount")) DESC
            `,
            {
              type: QueryTypes.SELECT,
              bind: {
                collectiveId: collective.id,
                ...computeDatesAsISOStrings(dateFrom, dateTo),
              },
            },
          );
        },
      },
      contributionsAmountTimeSeries: {
        type: new GraphQLNonNull(TimeSeriesAmount),
        description: 'Return amount time series for contributions (default, and only for now: one-time vs recurring)',
        args: {
          ...TimeSeriesArgs,
        },
        async resolve(collective, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, collective) || 1);
          const results = await sequelize.query(
            `
            SELECT
            DATE_TRUNC($timeUnit, t."createdAt") AS "date",
            (CASE WHEN o."SubscriptionId" IS NOT NULL THEN 'recurring' ELSE 'one-time' END) as "label",
            ABS(SUM(t."amount")) as "amount",
            t."currency"
            FROM "Transactions" t
            LEFT JOIN "Orders" o
            ON t."OrderId" = o."id"
            WHERE t."type" = 'CREDIT'
            AND t."kind" = 'CONTRIBUTION'
            AND t."CollectiveId" = $collectiveId
            AND t."RefundTransactionId" IS NULL
            AND t."deletedAt" IS NULL
            ${dateFrom ? `AND t."createdAt" >= $startDate` : ``}
            ${dateTo ? `AND t."createdAt" <= $endDate` : ``}
            GROUP BY DATE_TRUNC($timeUnit, t."createdAt"), (CASE WHEN o."SubscriptionId" IS NOT NULL THEN 'recurring' ELSE 'one-time' END), t."currency"
            ORDER BY DATE_TRUNC($timeUnit, t."createdAt"), ABS(SUM(t."amount")) DESC
            `,
            {
              type: QueryTypes.SELECT,
              bind: {
                collectiveId: collective.id,
                timeUnit,
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
