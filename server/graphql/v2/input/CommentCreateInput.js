import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import { ExpenseReferenceInput } from './ExpenseReferenceInput';

/**
 * Input type to use as the type for the comment input in createComment mutation.
 */
export const CommentCreateInput = new GraphQLInputObjectType({
  name: 'CommentCreateInput',
  fields: () => ({
    html: { type: GraphQLString },
    expense: {
      type: ExpenseReferenceInput,
      description: 'If your comment is linked to an expense, set it here',
    },
    ExpenseId: {
      type: GraphQLInt,
      deprecationReason: '2019-02-26: Please use the expense field',
    },
    ConversationId: { type: GraphQLString },
  }),
});
