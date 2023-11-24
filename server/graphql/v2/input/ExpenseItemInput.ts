import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import URL from '../scalar/URL';

import { GraphQLAmountInput } from './AmountInput';

/**
 * To create or edit an expense item
 */
export const GraphQLExpenseItemInput = new GraphQLInputObjectType({
  name: 'ExpenseItemInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'ID of the item',
    },
    amount: {
      type: GraphQLInt,
      description: 'Amount in cents',
      deprecationReason: 'Please use `amountV2`',
    },
    amountV2: {
      type: GraphQLAmountInput,
      description: 'Amount',
    },
    description: {
      type: GraphQLString,
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
