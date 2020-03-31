import { GraphQLNonNull, GraphQLString } from 'graphql';
import { Comment } from '../object/Comment';
import { CommentCreateInput } from '../input/CommentCreateInput';
import { CommentUpdateInput } from '../input/CommentUpdateInput';
import { createCommentResolver, deleteComment, editComment } from '../../common/comment';
import { IDENTIFIER_TYPES, getDecodedId, idDecode } from '../identifiers';
import { fetchExpenseWithReference } from '../input/ExpenseReferenceInput';

const commentMutations = {
  editComment: {
    type: Comment,
    args: {
      comment: {
        type: new GraphQLNonNull(CommentUpdateInput),
      },
    },
    resolve(_, { comment }, { remoteUser }) {
      const commentToEdit = { ...comment, id: getDecodedId(comment.id) };
      return editComment(commentToEdit, remoteUser);
    },
  },
  deleteComment: {
    type: Comment,
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    resolve(_, { id }, { remoteUser }) {
      const decodedId = getDecodedId(id);
      return deleteComment(decodedId, remoteUser);
    },
  },
  createComment: {
    type: Comment,
    args: {
      comment: {
        type: new GraphQLNonNull(CommentCreateInput),
      },
    },
    resolve: async (entity, args, req) => {
      if (args.comment.ConversationId) {
        args.comment.ConversationId = idDecode(args.comment.ConversationId, IDENTIFIER_TYPES.CONVERSATION);
      }

      if (args.comment.expense) {
        const expense = await fetchExpenseWithReference(args.comment.expense, req);
        if (!expense) {
          throw new Error('This expense does not exists');
        }
        args.comment.ExpenseId = expense.id;
      }

      return createCommentResolver(entity, args, req);
    },
  },
};

export default commentMutations;
