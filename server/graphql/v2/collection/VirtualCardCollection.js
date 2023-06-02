import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLVirtualCard } from '../object/VirtualCard';

export const GraphQLVirtualCardCollection = new GraphQLObjectType({
  name: 'VirtualCardCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of Virtual Cards',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(GraphQLVirtualCard),
    },
  }),
});
