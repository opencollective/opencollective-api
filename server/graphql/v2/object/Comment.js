import { GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { GraphQLJSONObject } from 'graphql-type-json';

import { collectiveResolver, fromCollectiveResolver, getStripTagsResolver } from '../../common/comment';
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
      markdown: {
        type: GraphQLString,
        resolve: getStripTagsResolver('markdown'),
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
        type: GraphQLJSONObject,
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
      // Deprecated
      fromCollective: {
        type: Account,
        resolve: fromCollectiveResolver,
        deprecationReason: '2020-02-25: Please use fromAccount',
      },
      collective: {
        type: Account,
        resolve: collectiveResolver,
        deprecationReason: '2020-02-25: Please use account',
      },
    };
  },
});

export { Comment };
