import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLRecurringExpenseInterval } from '../enum/RecurringExpenseInterval.js';

export const GraphQLRecurringExpenseInput = new GraphQLInputObjectType({
  name: 'RecurringExpenseInput',
  fields: () => ({
    interval: {
      type: new GraphQLNonNull(GraphQLRecurringExpenseInterval),
      description: 'The interval in which this recurring expense is created',
    },
    endsAt: {
      type: GraphQLDateTime,
      description: 'The date when this recurring expense should cease',
    },
  }),
});
