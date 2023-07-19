import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLActivity } from '../object/Activity.js';

export const GraphQLActivityCollection = new GraphQLObjectType({
  name: 'ActivityCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Activities"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLActivity)),
      },
    };
  },
});
