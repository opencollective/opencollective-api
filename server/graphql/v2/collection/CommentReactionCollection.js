import { GraphQLObjectType, GraphQLString } from 'graphql';

const CommentReactionCollection = new GraphQLObjectType({
  name: 'CommentReactionCollection',
  description: 'A collection of "Comment Reactions"',
  fields: () => {
    return {
      emojis: {
        type: GraphQLString,
      },
    };
  },
});

export { CommentReactionCollection };
