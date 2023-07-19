import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import GraphQLHostApplication from '../object/HostApplication.js';

export const GraphQLHostApplicationCollection = new GraphQLObjectType({
  name: 'HostApplicationCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "HostApplication"',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(GraphQLHostApplication),
    },
  }),
});
