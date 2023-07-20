import { GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import URL from '../scalar/URL.js';

/**
 * Input type to use as the type for the expense input in createExpense mutation.
 */
export const GraphQLExpenseItemCreateInput = new GraphQLInputObjectType({
  name: 'ExpenseItemCreateInput',
  fields: () => ({
    amount: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Amount in cents',
    },
    description: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'What is this item about?',
    },
    url: {
      type: URL,
      description: 'URL of the file linked to this item. Must be provided if the expense type is RECEIPT.',
    },
    incurredAt: {
      type: GraphQLDateTime,
      description: 'When was the money spent?',
    },
  }),
});
