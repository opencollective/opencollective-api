import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLTagStats } from '../object/TagStats.js';

export const GraphQLTagStatsCollection = new GraphQLObjectType({
  name: 'TagStatsCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Tags"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLTagStats),
      },
    };
  },
});
