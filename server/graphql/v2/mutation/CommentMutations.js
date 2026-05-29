import { GraphQLNonNull, GraphQLString } from 'graphql';

import { mustBeLoggedInTo } from '../../../lib/auth';
import { EntityShortIdPrefix, isEntityPublicId } from '../../../lib/permalink/entity-map';
import { createComment, deleteComment, editComment } from '../../common/comment';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLCommentCreateInput } from '../input/CommentCreateInput';
import { GraphQLCommentUpdateInput } from '../input/CommentUpdateInput';
import { getConversationDatabaseIdFromReference } from '../input/ConversationReferenceInput';
import { getDatabaseIdFromExpenseReference } from '../input/ExpenseReferenceInput';
import { getDatabaseIdFromHostApplicationReference } from '../input/HostApplicationReferenceInput';
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
    // eslint-disable-next-line graphql-mutations/require-scope-check -- scope check is performed inside editComment (common/comment.ts)
    async resolve(_, { comment }, req) {
      let id;
      if (isEntityPublicId(comment.id, EntityShortIdPrefix.Comment)) {
        id = await req.loaders.Comment.idByPublicId.load(comment.id);
      } else {
        id = idDecode(comment.id, IDENTIFIER_TYPES.COMMENT);
      }

      const commentToEdit = { ...comment, id };
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
    // eslint-disable-next-line graphql-mutations/require-scope-check -- scope check is performed inside deleteComment (common/comment.ts)
    async resolve(_, { id }, req) {
      let decodedId;
      if (isEntityPublicId(id, EntityShortIdPrefix.Comment)) {
        decodedId = await req.loaders.Comment.idByPublicId.load(id);
      } else {
        decodedId = idDecode(id, IDENTIFIER_TYPES.COMMENT);
      }

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
    // eslint-disable-next-line graphql-mutations/require-scope-check -- scope check is performed inside createComment (common/comment.ts)
    resolve: async (_, { comment }, req) => {
      mustBeLoggedInTo(req.remoteUser, 'create a comment');

      // Associate the comment with the correct entity
      if (comment.ConversationId) {
        if (isEntityPublicId(comment.ConversationId, EntityShortIdPrefix.Conversation)) {
          comment.ConversationId = await req.loaders.Conversation.idByPublicId.load(comment.ConversationId);
        } else {
          comment.ConversationId = idDecode(comment.ConversationId, IDENTIFIER_TYPES.CONVERSATION);
        }
      } else if (comment.conversation) {
        comment.ConversationId = await getConversationDatabaseIdFromReference(comment.conversation);
      } else if (comment.update) {
        comment.UpdateId = await getDatabaseIdFromUpdateReference(comment.update);
      } else if (comment.expense) {
        comment.ExpenseId = await getDatabaseIdFromExpenseReference(comment.expense);
      } else if (comment.order) {
        comment.OrderId = await getDatabaseIdFromOrderReference(comment.order);
      } else if (comment.hostApplication) {
        comment.HostApplicationId = await getDatabaseIdFromHostApplicationReference(comment.hostApplication);
      } else {
        throw new Error('Please provide a conversation, update, expense, order or host application');
      }

      return createComment(comment, req);
    },
  },
};

export default commentMutations;
