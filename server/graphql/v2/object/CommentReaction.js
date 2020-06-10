import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { fromCollectiveResolver } from '../../common/comment';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { Account } from '../interface/Account';

const CommentReaction = new GraphQLObjectType({
  name: 'CommentReaction',
  description: 'This represents an Comment Reaction',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'An unique identifier for this comment reaction',
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.COMMENT_REACTION),
      },
      emoji: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'The emoji associated with this user and comment',
      },
      fromAccount: {
        type: new GraphQLNonNull(Account),
        description: 'The account associated with this reaction',
        resolve: fromCollectiveResolver,
      },
      createdAt: {
        type: new GraphQLNonNull(GraphQLDateTime),
        description: 'The time this comment was created',
      },
    };
  },
});

export { CommentReaction };
