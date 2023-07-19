import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLVirtualCardRequest } from '../object/VirtualCardRequest.js';

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
