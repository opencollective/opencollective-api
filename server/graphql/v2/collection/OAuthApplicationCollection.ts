import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLApplication } from '../object/Application';

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
