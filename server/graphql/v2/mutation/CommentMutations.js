import { GraphQLNonNull, GraphQLString } from 'graphql';

import { createComment, deleteComment, editComment } from '../../common/comment';
import { Unauthorized } from '../../errors';
import { getDecodedId, idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { CommentCreateInput } from '../input/CommentCreateInput';
import { CommentUpdateInput } from '../input/CommentUpdateInput';
import { fetchExpenseWithReference } from '../input/ExpenseReferenceInput';
import { fetchUpdateWithReference } from '../input/UpdateReferenceInput';
import { Comment } from '../object/Comment';

const commentMutations = {
  editComment: {
    type: Comment,
    args: {
      comment: {
        type: new GraphQLNonNull(CommentUpdateInput),
      },
    },
    resolve(_, { comment }, req) {
      const commentToEdit = { ...comment, id: getDecodedId(comment.id) };
      return editComment(commentToEdit, req);
    },
  },
  deleteComment: {
    type: Comment,
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    resolve(_, { id }, req) {
      const decodedId = getDecodedId(id);
      return deleteComment(decodedId, req);
    },
  },
  createComment: {
    type: Comment,
    args: {
      comment: {
        type: new GraphQLNonNull(CommentCreateInput),
      },
    },
    resolve: async (_, args, req) => {
      if (args.comment.ConversationId) {
        args.comment.ConversationId = idDecode(args.comment.ConversationId, IDENTIFIER_TYPES.CONVERSATION);
      }

      if (args.comment.update) {
        const update = await fetchUpdateWithReference(args.comment.update, {
          loaders: req.loaders,
          throwIfMissing: true,
        });
        if (update.isPrivate || !update.publishedAt) {
          update.collective = update.collective || (await req.loaders.Collective.byId.load(update.CollectiveId));
          if (!req.remoteUser?.canSeePrivateUpdatesForCollective(update.collective)) {
            throw new Unauthorized('You do not have the permission to post comments on this update');
          }
        }
        args.comment.UpdateId = update.id;
      }

      if (args.comment.expense) {
        const expense = await fetchExpenseWithReference(args.comment.expense, req);
        if (!expense) {
          throw new Error('This expense does not exist');
        }
        args.comment.ExpenseId = expense.id;
      }

      return createComment(args, req);
    },
  },
};

export default commentMutations;
