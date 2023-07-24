import { GraphQLNonNull, GraphQLString } from 'graphql';

import { mustBeLoggedInTo } from '../../../lib/auth';
import { createComment, deleteComment, editComment } from '../../common/comment';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLCommentCreateInput } from '../input/CommentCreateInput';
import { GraphQLCommentUpdateInput } from '../input/CommentUpdateInput';
import { getConversationDatabaseIdFromReference } from '../input/ConversationReferenceInput';
import { getDatabaseIdFromExpenseReference } from '../input/ExpenseReferenceInput';
import { getDatabaseIdFromOrderReference } from '../input/OrderReferenceInput';
import { getDatabaseIdFromUpdateReference } from '../input/UpdateReferenceInput';
import { GraphQLComment } from '../object/Comment';

const commentMutations = {
  editComment: {
    type: GraphQLComment,
    description: 'Edit a comment. Scope: "conversations", "expenses" or "updates".',
    args: {
      comment: {
        type: new GraphQLNonNull(GraphQLCommentUpdateInput),
      },
    },
    resolve(_, { comment }, req) {
      const commentToEdit = { ...comment, id: idDecode(comment.id, IDENTIFIER_TYPES.COMMENT) };
      return editComment(commentToEdit, req);
    },
  },
  deleteComment: {
    type: GraphQLComment,
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    resolve(_, { id }, req) {
      const decodedId = idDecode(id, IDENTIFIER_TYPES.COMMENT);
      return deleteComment(decodedId, req);
    },
  },
  createComment: {
    type: GraphQLComment,
    description: 'Create a comment. Scope: "conversations", "expenses" or "updates".',
    args: {
      comment: {
        type: new GraphQLNonNull(GraphQLCommentCreateInput),
      },
    },
    resolve: async (_, { comment }, req) => {
      mustBeLoggedInTo(req.remoteUser, 'create a comment');

      // Associate the comment with the correct entity
      if (comment.ConversationId) {
        comment.ConversationId = idDecode(comment.ConversationId, IDENTIFIER_TYPES.CONVERSATION);
      } else if (comment.conversation) {
        comment.ConversationId = getConversationDatabaseIdFromReference(comment.conversation);
      } else if (comment.update) {
        comment.UpdateId = getDatabaseIdFromUpdateReference(comment.update);
      } else if (comment.expense) {
        comment.ExpenseId = getDatabaseIdFromExpenseReference(comment.expense);
      } else if (comment.order) {
        comment.OrderId = getDatabaseIdFromOrderReference(comment.order);
      } else {
        throw new Error('Please provide a conversation, update, expense or order');
      }

      return createComment(comment, req);
    },
  },
};

export default commentMutations;
