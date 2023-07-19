import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLComment } from '../object/Comment.js';

const GraphQLCommentCollection = new GraphQLObjectType({
  name: 'CommentCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Comments"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLComment),
      },
    };
  },
});

export { GraphQLCommentCollection as CommentCollection };
