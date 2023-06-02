import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';

import { collectiveResolver, fromCollectiveResolver } from '../../common/comment';
import { GraphQLCommentType } from '../enum/CommentType';
import { getIdEncodeResolver } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

export const GraphQLComment = new GraphQLObjectType({
  name: 'Comment',
  description: 'This represents an Comment',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        resolve: getIdEncodeResolver('comment'),
      },
      createdAt: {
        type: GraphQLDateTime,
      },
      html: {
        type: GraphQLString,
      },
      fromAccount: {
        type: GraphQLAccount,
        resolve: fromCollectiveResolver,
      },
      account: {
        type: GraphQLAccount,
        resolve: collectiveResolver,
      },
      type: {
        type: new GraphQLNonNull(GraphQLCommentType),
        description: 'The type of this comment',
      },
      reactions: {
        type: GraphQLJSON,
        description: 'Returns a map of reactions counts for this comment',
        async resolve(comment, args, req) {
          return await req.loaders.Comment.reactionsByCommentId.load(comment.id);
        },
      },
      userReactions: {
        type: new GraphQLList(GraphQLString),
        description: 'Returns the list of reactions added to this comment by logged in user',
        async resolve(comment, args, req) {
          if (req.remoteUser) {
            return req.loaders.Comment.remoteUserReactionsByCommentId.load(comment.id);
          }
        },
      },
    };
  },
});
