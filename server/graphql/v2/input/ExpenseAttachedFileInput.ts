import { GraphQLString, GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

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
      type: new GraphQLNonNull(GraphQLString),
      description: 'URL of the file',
    },
  },
});
