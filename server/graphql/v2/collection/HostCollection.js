import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLHost } from '../object/Host.js';

export const GraphQLHostCollection = new GraphQLObjectType({
  name: 'HostCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Hosts"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLHost),
      },
    };
  },
});
