import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLPersonalToken } from '../object/PersonalToken';

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
