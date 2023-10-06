import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import URL from '../scalar/URL';

/**
 * To create or edit an optional expense file attachment
 */
export const GraphQLExpenseAttachedFileInput = new GraphQLInputObjectType({
  name: 'ExpenseAttachedFileInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'ID of the file',
    },
    name: {
      type: GraphQLString,
      description: 'Original filename',
      deprecationReason:
        '2023-02-02: This must now be provided when uploading the file. This parameter will be ignored.',
    },
    url: {
      type: new GraphQLNonNull(URL),
      description: 'URL of the file',
    },
  }),
});
