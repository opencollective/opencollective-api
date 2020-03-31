import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { Comment } from '../object/Comment';

const CommentCollection = new GraphQLObjectType({
  name: 'CommentCollection',
  interfaces: [Collection],
  description: 'A collection of "Comments"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(Comment),
      },
    };
  },
});

export { CommentCollection };
