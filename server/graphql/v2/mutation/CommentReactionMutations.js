import { GraphQLNonNull, GraphQLString } from 'graphql';

import { mustBeLoggedInTo } from '../../../lib/auth';
import models from '../../../models';
import { NotFound, Unauthorized } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CommentReferenceInput } from '../input/CommentReferenceInput';
import { Comment } from '../object/Comment';

const commentReactionMutations = {
  addCommentReaction: {
    type: new GraphQLNonNull(Comment),
    args: {
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The emoji associated with the reaction',
      },
      comment: {
        type: new GraphQLNonNull(CommentReferenceInput),
        description: 'A unique identifier for the comment id associated with this comment reaction',
      },
      fromAccount: {
        type: new GraphQLNonNull(AccountReferenceInput),
        description: 'A unique identifier for the account associated with this reaction',
      },
    },
    resolve: async (entity, args, req) => {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const fromAccount = await fetchAccountWithReference(args.fromAccount, {
        throwIfMissing: true,
        loaders: req.loaders,
      });
      if (!req.remoteUser.isAdmin(fromAccount.id)) {
        throw new Unauthorized();
      }

      const commentId = idDecode(args.comment.id, IDENTIFIER_TYPES.COMMENT);
      const reaction = await models.CommentReaction.addReaction(req.remoteUser, commentId, fromAccount.id, args.emoji);
      return req.loaders.Comment.byId.load(reaction.CommentId);
    },
  },

  removeCommentReaction: {
    type: new GraphQLNonNull(Comment),
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    resolve: async (_, { id }, { loaders, remoteUser }) => {
      mustBeLoggedInTo(remoteUser, 'remove this comment reaction');
      const decodedId = decodedId(id, IDENTIFIER_TYPES.COMMENT_REACTION);
      const reaction = await models.CommentReaction.findByPk(id);
      if (!reaction) {
        throw new NotFound(`This comment reaction does not exist or has been deleted.`);
      }

      // Check permissions
      if (!remoteUser.isAdmin(reaction.FromCollectiveId)) {
        throw new Unauthorized();
      }

      await reaction.destroy();
      return loaders.Comment.byId.load(reaction.CommentId);
    },
  },
};

export default commentReactionMutations;
