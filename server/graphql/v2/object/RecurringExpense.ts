import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLRecurringExpenseInterval } from '../enum/RecurringExpenseInterval.js';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers.js';
import { GraphQLAccount } from '../interface/Account.js';

import { GraphQLExpense } from './Expense.js';

const GraphQLRecurringExpense = new GraphQLObjectType({
  name: 'RecurringExpense',
  description: 'A recurring expense object',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.RECURRING_EXPENSE),
      description: 'Unique identifier for this recurring expense',
    },
    interval: {
      type: new GraphQLNonNull(GraphQLRecurringExpenseInterval),
      description: 'The interval in which this recurring expense is created',
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(recurringExpense, _, req) {
        if (recurringExpense.CollectiveId) {
          return req.loaders.Collective.byId.load(recurringExpense.CollectiveId);
        }
      },
    },
    fromAccount: {
      type: new GraphQLNonNull(GraphQLAccount),
      resolve(recurringExpense, _, req) {
        if (recurringExpense.FromCollectiveId) {
          return req.loaders.Collective.byId.load(recurringExpense.FromCollectiveId);
        }
      },
    },
    lastDraftedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The last time this recurring expense was paid for',
    },
    endsAt: {
      type: GraphQLDateTime,
      description: 'The time this expense will cease to be recurring',
    },
    lastExpenseCreated: {
      type: GraphQLExpense,
      description: 'The last expense created by this recurring expense record paid for',
      resolve(recurringExpense) {
        return recurringExpense.getLastExpense();
      },
    },
  }),
});

export default GraphQLRecurringExpense;
