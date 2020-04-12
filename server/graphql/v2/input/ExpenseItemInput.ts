import { GraphQLInputObjectType,GraphQLInt, GraphQLString } from 'graphql';

import { DateString } from '../../v1/types';
import URL from '../scalar/URL';

/**
 * To create or edit an expense item
 */
export const ExpenseItemInput = new GraphQLInputObjectType({
  name: 'ExpenseItemInput',
  fields: {
    id: {
      type: GraphQLString,
      description: 'ID of the item',
    },
    amount: {
      type: GraphQLInt,
      description: 'Amount in cents',
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
      type: DateString,
      description: 'When was the money spent?',
    },
  },
});
