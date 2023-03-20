import { GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { GraphQLJSON } from 'graphql-scalars';

import { collectiveResolver, fromCollectiveResolver } from '../../common/comment';
import { getIdEncodeResolver } from '../identifiers';
import { Account } from '../interface/Account';

const Comment = new GraphQLObjectType({
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
        type: Account,
        resolve: fromCollectiveResolver,
      },
      account: {
        type: Account,
        resolve: collectiveResolver,
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

export { Comment };
