import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { VirtualCard } from '../object/VirtualCard';

export const VirtualCardCollection = new GraphQLObjectType({
  name: 'VirtualCardCollection',
  interfaces: [Collection],
  description: 'A collection of Virtual Cards',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(VirtualCard),
    },
  }),
});
