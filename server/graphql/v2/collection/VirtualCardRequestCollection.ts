import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLVirtualCardRequest } from '../object/VirtualCardRequest';

export const GraphQLVirtualCardRequestCollection = new GraphQLObjectType({
  name: 'VirtualCardRequestCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "VirtualCardRequest"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLVirtualCardRequest)),
      },
    };
  },
});
