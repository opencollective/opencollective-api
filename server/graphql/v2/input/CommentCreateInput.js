import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { ConversationReferenceInput } from './ConversationReferenceInput';
import { ExpenseReferenceInput } from './ExpenseReferenceInput';
import { UpdateReferenceInput } from './UpdateReferenceInput';

/**
 * Input type to use as the type for the comment input in createComment mutation.
 */
export const CommentCreateInput = new GraphQLInputObjectType({
  name: 'CommentCreateInput',
  description: 'Input to create a comment. You can only specify one entity type: expense, conversation or update',
  fields: () => ({
    html: { type: GraphQLString },
    expense: {
      type: ExpenseReferenceInput,
      description: 'If your comment is linked to an expense, set it here',
    },
    ConversationId: { type: GraphQLString, deprecationReason: '2022-08-26: Please use "conversation"' },
    conversation: { type: ConversationReferenceInput },
    update: { type: UpdateReferenceInput },
  }),
});
