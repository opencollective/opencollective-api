import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLPersonalToken } from '../object/PersonalToken.js';

export const GraphQLPersonalTokenCollection = new GraphQLObjectType({
  name: 'PersonalTokenCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "PersonalToken"',
  fields: () => ({
    ...CollectionFields,
    nodes: {
      type: new GraphQLList(GraphQLPersonalToken),
    },
  }),
});
