import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { get, has } from 'lodash';

import queries from '../../../lib/queries';
import { TransactionKind } from '../enum/TransactionKind';
import { idEncode } from '../identifiers';
import { Amount } from '../object/Amount';
export const AccountStats = new GraphQLObjectType({
  name: 'AccountStats',
  description: 'Stats for the Account',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
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
        resolve(account, args, req) {
          return account.getBalanceAmount({ loaders: req.loaders });
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
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'Calculate total amount received before this date',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'Calculate total amount received after this date',
          },
        },
        resolve(collective, args) {
          const kind = args.kind && args.kind.length > 0 ? args.kind : undefined;
          return collective.getTotalAmountReceivedAmount({ kind, startDate: args.dateFrom, endDate: args.dateTo });
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
    };
  },
});
