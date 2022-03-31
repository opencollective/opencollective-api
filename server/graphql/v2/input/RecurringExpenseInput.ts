import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { RecurringExpenseInterval } from '../enum/RecurringExpenseInterval';

const RecurringExpenseInput = new GraphQLInputObjectType({
  name: 'RecurringExpenseInput',
  fields: () => ({
    interval: {
      type: new GraphQLNonNull(RecurringExpenseInterval),
      description: 'The interval in which this recurring expense is created',
    },
    endsAt: {
      type: GraphQLDateTime,
      description: 'The date when this recurring expense should cease',
    },
  }),
});

export { RecurringExpenseInput };
