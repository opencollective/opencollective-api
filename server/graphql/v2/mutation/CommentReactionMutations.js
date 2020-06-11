import { GraphQLNonNull, GraphQLString } from 'graphql';

import { mustBeLoggedInTo } from '../../../lib/auth';
import models from '../../../models';
import { NotFound, Unauthorized } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
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
    },
    resolve: async (entity, args, req) => {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      const commentId = idDecode(args.comment.id, IDENTIFIER_TYPES.COMMENT);
      const reaction = await models.CommentReaction.addReaction(req.remoteUser, commentId, args.emoji);
      return req.loaders.Comment.byId.load(reaction.CommentId);
    },
  },

  removeCommentReaction: {
    type: new GraphQLNonNull(Comment),
    args: {
      comment: {
        type: new GraphQLNonNull(CommentReferenceInput),
      },
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
      },
    },
    resolve: async (_, { comment, emoji }, { loaders, remoteUser }) => {
      mustBeLoggedInTo(remoteUser, 'remove this comment reaction');
      const commentId = idDecode(comment.id, IDENTIFIER_TYPES.COMMENT);
      const reaction = await models.CommentReaction.findOne({
        where: {
          CommentId: commentId,
          emoji,
        },
      });

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
