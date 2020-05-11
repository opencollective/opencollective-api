import { GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { fromCollectiveResolver } from '../../common/comment';
import { Account } from '../interface/Account';

const CommentReaction = new GraphQLObjectType({
  name: 'CommentReaction',
  description: 'This represents an Comment Reaction',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        description: 'An unique identifier for this comment reaction',
      },
      emoji: {
        type: GraphQLString,
        description: 'The emoji associated with this user and comment',
      },
      fromAccount: {
        type: Account,
        resolve: fromCollectiveResolver,
        description: 'The account associated with this reaction',
      },
      createdAt: {
        type: GraphQLDateTime,
        description: 'The time this comment was created',
      },
      updatedAt: {
        type: GraphQLDateTime,
        description: 'The time this comment reaction was last updated',
      },
    };
  },
});

export { CommentReaction };
