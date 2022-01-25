import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-type-json';
import { get, has } from 'lodash';
import moment from 'moment';

import queries from '../../../lib/queries';
import { Currency } from '../enum/Currency';
import { ExpenseType } from '../enum/ExpenseType';
import { TransactionKind } from '../enum/TransactionKind';
import { idEncode } from '../identifiers';
import { Amount } from '../object/Amount';

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
        },
        resolve(collective, args) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          let { dateFrom, dateTo } = args;

          if (args.periodInMonths) {
            dateFrom = moment().subtract(args.periodInMonths, 'months').seconds(0).milliseconds(0).toDate();
            dateTo = null;
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
    };
  },
});
