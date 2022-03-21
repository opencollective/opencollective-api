import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { RecurringExpenseInterval } from '../enum/RecurringExpenseInterval';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';

import { Expense } from './Expense';

const RecurringExpense = new GraphQLObjectType({
  name: 'RecurringExpense',
  description: 'A recurring expense object',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.RECURRING_EXPENSE),
      description: 'Unique identifier for this recurring expense',
    },
    interval: {
      type: RecurringExpenseInterval,
      description: 'The interval in which this recurring expense is created',
    },
    account: {
      type: Account,
      resolve(recurringExpense, _, req) {
        if (recurringExpense.CollectiveId) {
          return req.loaders.Collective.byId.load(recurringExpense.CollectiveId);
        }
      },
    },
    fromAccount: {
      type: Account,
      resolve(recurringExpense, _, req) {
        if (recurringExpense.FromCollectiveId) {
          return req.loaders.Collective.byId.load(recurringExpense.FromCollectiveId);
        }
      },
    },
    lastDraftedAt: {
      type: GraphQLDateTime,
      description: 'The last time this recurring expense was paid for',
    },
    endAt: {
      type: GraphQLDateTime,
      description: 'The time this expense will cease to be recurring',
    },
    lastExpenseCreated: {
      type: Expense,
      description: 'The last expense created by this recurring expense record paid for',
      resolve(recurringExpense) {
        return recurringExpense.getLastExpense();
      },
    },
  }),
});

export default RecurringExpense;
