import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import GraphQLHostApplication from '../object/HostApplication';

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
