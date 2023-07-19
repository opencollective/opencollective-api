import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLApplication } from '../object/Application.js';

export const GraphQLOAuthApplicationCollection = new GraphQLObjectType({
  name: 'OAuthApplicationCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Application"',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(GraphQLApplication),
    },
  }),
});
