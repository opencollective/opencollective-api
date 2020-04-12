import { GraphQLInputObjectType, GraphQLNonNull,GraphQLString } from 'graphql';

import URL from '../scalar/URL';

/**
 * To create or edit an optional expense file attachment
 */
export const ExpenseAttachedFileInput = new GraphQLInputObjectType({
  name: 'ExpenseAttachedFileInput',
  fields: {
    id: {
      type: GraphQLString,
      description: 'ID of the file',
    },
    url: {
      type: new GraphQLNonNull(URL),
      description: 'URL of the file',
    },
  },
});
