import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLHost } from '../object/Host';

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
