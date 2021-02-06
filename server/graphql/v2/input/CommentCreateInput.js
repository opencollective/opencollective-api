import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { ExpenseReferenceInput } from './ExpenseReferenceInput';
import { UpdateReferenceInput } from './UpdateReferenceInput';

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
    ConversationId: { type: GraphQLString },
    update: { type: UpdateReferenceInput },
  }),
});
