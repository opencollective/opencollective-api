import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-type-json';
import { get, has, isNil } from 'lodash';
import moment from 'moment';

import { getCollectiveIds } from '../../../lib/budget';
import { getFxRate } from '../../../lib/currency';
import queries from '../../../lib/queries';
import sequelize, { QueryTypes } from '../../../lib/sequelize';
import { computeDatesAsISOStrings } from '../../../lib/utils';
import models from '../../../models';
import { ContributionFrequency } from '../enum/ContributionFrequency';
import { Currency } from '../enum/Currency';
import { ExpenseType } from '../enum/ExpenseType';
import { TimeUnit } from '../enum/TimeUnit';
import { TransactionKind } from '../enum/TransactionKind';
import { idEncode } from '../identifiers';
import { Amount } from '../object/Amount';
import { AmountStats } from '../object/AmountStats';
import { getNumberOfDays, getTimeUnit, TimeSeriesAmount, TimeSeriesArgs } from '../object/TimeSeriesAmount';

const DateArgs = {
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Start date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'End date',
  },
};

const includeChildren = {
  type: GraphQLBoolean,
  description: 'Include transactions from children (Projects and Events)',
  defaultValue: false,
};

const TransactionArgs = {
  kind: {
    type: new GraphQLList(TransactionKind),
    description: 'Filter by kind',
  },
  periodInMonths: {
    type: GraphQLInt,
    description: 'Calculate total amount spent in the last x months. Cannot be used with startDate/endDate',
  },
  includeChildren,
  ...DateArgs,
};

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
          includeChildren: {
            type: GraphQLBoolean,
            description: 'Include balance from children (Projects and Events)',
            defaultValue: false,
          },
        },
        resolve(account, args, req) {
          return account.getBalanceAmount({
            loaders: req.loaders,
            startDate: args.dateFrom,
            endDate: args.dateTo,
            includeChildren: args.includeChildren,
          });
        },
      },
      consolidatedBalance: {
        description: 'The consolidated amount of all the events and projects combined.',
        deprecationReason: '2022-09-02: Use balance + includeChildren instead',
        type: new GraphQLNonNull(Amount),
        resolve(account) {
          return account.getBalanceAmount({
            includeChildren: true,
          });
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
        args: {
          ...TransactionArgs,
          currency: {
            type: Currency,
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
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
            currency: args.currency,
          });
        },
      },
      totalAmountReceived: {
        description: 'Total amount received',
        type: new GraphQLNonNull(Amount),
        args: {
          ...TransactionArgs,
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
          if (args.useCache && !dateFrom && !dateTo && !args.includeChildren) {
            const cachedAmount = collective.dataValues['__stats_totalAmountReceivedInHostCurrency__'];
            if (!isNil(cachedAmount)) {
              const host = collective.HostCollectiveId && (await req.loaders.Collective.host.load(collective));
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

          return collective.getTotalAmountReceivedAmount({
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
          });
        },
      },
      totalPaidExpenses: {
        description: 'Total of paid expenses to the account, filter per expense type',
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
        args: {
          ...TransactionArgs,
        },
        async resolve(collective, args, req) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
          }
          return collective.getTotalNetAmountReceivedAmount({
            loaders: req.loaders,
            kind,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
          });
        },
      },
      totalNetAmountReceivedTimeSeries: {
        description: 'Total net amount received time series',
        // TODO: include total?
        type: new GraphQLNonNull(TimeSeriesAmount),
        args: {
          // TODO: remove Kind from args?
          ...TransactionArgs,
          timeUnit: {
            type: new GraphQLNonNull(TimeUnit),
            description: 'The time unit of the time series',
          },
          currency: {
            type: Currency,
          },
        },
        async resolve(collective, args, req) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
          }
          return collective.getTotalNetAmountReceivedTimeSeries({
            loaders: req.loaders,
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
          return req.loaders.Collective.stats.activeRecurringContributions.load(collective.id);
        },
      },
      activeRecurringContributionsV2: {
        type: Amount,
        args: {
          frequency: {
            type: new GraphQLNonNull(ContributionFrequency),
            description: 'The frequency of the recurring contribution (MONTHLY or YEARLY)',
            defaultValue: 'MONTHLY',
          },
        },
        async resolve(collective, args, req) {
          const key = args.frequency.toLowerCase();
          if (!['monthly', 'yearly'].includes(key)) {
            throw new Error('Unsupported frequency.');
          }
          const stats = await req.loaders.Collective.stats.activeRecurringContributions.load(collective.id);
          const currency = collective.currency;
          // There is no guarantee that stats are returned in collective.currency, we convert to be sure
          const fxRate = await getFxRate(stats.currency, currency);
          const value = Math.round(stats[key] * fxRate);
          return {
            value: value,
            currency: currency,
          };
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
          includeChildren: {
            type: GraphQLBoolean,
            description: 'Include contributions to children (Projects and Events)',
            defaultValue: false,
          },
        },
        async resolve(collective, args) {
          const limit = args.limit;
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const includeChildren = args.includeChildren;
          return models.Expense.getCollectiveExpensesTags(collective, { limit, dateFrom, dateTo, includeChildren });
        },
      },
      expensesTagsTimeSeries: {
        type: new GraphQLNonNull(TimeSeriesAmount),
        args: {
          ...TimeSeriesArgs,
          includeChildren: {
            type: GraphQLBoolean,
            description: 'Include expense to children (Projects and Events)',
            defaultValue: false,
          },
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
          ...DateArgs,
          includeChildren,
        },
        async resolve(collective, args, req) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;

          const { contributions } = await collective.getContributionsAndContributorsCount({
            loaders: req.loaders,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
          });
          return contributions;
        },
      },
      contributorsCount: {
        type: new GraphQLNonNull(GraphQLInt),
        args: {
          ...DateArgs,
          includeChildren,
        },
        async resolve(collective, args, req) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;

          const { contributors } = await collective.getContributionsAndContributorsCount({
            loaders: req.loaders,
            startDate: dateFrom,
            endDate: dateTo,
            includeChildren: args.includeChildren,
          });
          return contributors;
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
          includeChildren: {
            type: GraphQLBoolean,
            description: 'Include contributions to children (Projects and Events)',
            defaultValue: false,
          },
        },
        async resolve(collective, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const collectiveIds = await getCollectiveIds(collective, args.includeChildren);
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
            INNER JOIN "Collectives" c
              ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL
            WHERE t."type" = 'CREDIT'
              AND t."kind" = 'CONTRIBUTION'
              AND t."CollectiveId" IN (:collectiveIds)
              AND t."RefundTransactionId" IS NULL
              AND t."deletedAt" IS NULL
              AND t."FromCollectiveId" NOT IN (:collectiveIds)
              ${dateFrom ? `AND t."createdAt" >= :startDate` : ``}
              ${dateTo ? `AND t."createdAt" <= :endDate` : ``}
            GROUP BY "label", t."currency"
            ORDER BY ABS(SUM(t."amount")) DESC
            `,
            {
              type: QueryTypes.SELECT,
              replacements: {
                collectiveIds,
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
          includeChildren: {
            type: GraphQLBoolean,
            description: 'Include contributions to children (Projects and Events)',
            defaultValue: false,
          },
        },
        async resolve(collective, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : moment(collective.createdAt || new Date(2015, 1, 1));
          const dateTo = args.dateTo ? moment(args.dateTo) : moment();
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, collective) || 1);
          const collectiveIds = await getCollectiveIds(collective, args.includeChildren);
          const results = await sequelize.query(
            `
            SELECT
              DATE_TRUNC(:timeUnit, t."createdAt") AS "date",
              (CASE WHEN o."SubscriptionId" IS NOT NULL THEN 'recurring' ELSE 'one-time' END) as "label",
              ABS(SUM(t."amount")) as "amount",
              t."currency"
            FROM "Transactions" t
            LEFT JOIN "Orders" o
              ON t."OrderId" = o."id"
            INNER JOIN "Collectives" c
              ON c."id" = t."CollectiveId" AND c."deletedAt" IS NULL
            WHERE
              t."type" = 'CREDIT'
              AND t."kind" = 'CONTRIBUTION'
              AND t."CollectiveId" IN (:collectiveIds)
              AND t."RefundTransactionId" IS NULL
              AND t."deletedAt" IS NULL
              AND t."FromCollectiveId" NOT IN (:collectiveIds)
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
