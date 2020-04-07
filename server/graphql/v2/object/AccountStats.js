import { get, has } from 'lodash';

import { GraphQLInt, GraphQLObjectType } from 'graphql';

import { Amount } from '../object/Amount';

import { idEncode } from '../identifiers';

import queries from '../../../lib/queries';

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
      balance: {
        description: 'Amount of money in cents in the currency of the collective currently available to spend',
        type: Amount,
        async resolve(collective, args, req) {
          return {
            value: await req.loaders.Collective.balance.load(collective.id),
            currency: collective.currency,
          };
        },
      },
      monthlySpending: {
        description: 'Average amount spent per month based on the last 90 days',
        type: Amount,
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
        type: Amount,
        async resolve(collective) {
          return {
            value: await collective.getTotalAmountSpent(),
            currency: collective.currency,
          };
        },
      },
      totalAmountReceived: {
        description: 'Net amount received',
        type: Amount,
        async resolve(collective) {
          return {
            value: await collective.getTotalAmountReceived(),
            currency: collective.currency,
          };
        },
      },
      yearlyBudget: {
        type: Amount,
        async resolve(collective) {
          // If the current account is a host, we aggregate the yearly budget across all the hosted collectives
          if (collective.isHostAccount) {
            return {
              value: await queries.getTotalAnnualBudgetForHost(collective.id),
              currency: collective.currency,
            };
          }
          return {
            value: await collective.getYearlyIncome(),
            currency: collective.currency,
          };
        },
      },
    };
  },
});
