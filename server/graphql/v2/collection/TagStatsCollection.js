import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { TagStats } from '../object/TagStats';

export const TagStatsCollection = new GraphQLObjectType({
  name: 'TagCollection',
  interfaces: [Collection],
  description: 'A collection of "Tags"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(TagStats),
      },
    };
  },
});
