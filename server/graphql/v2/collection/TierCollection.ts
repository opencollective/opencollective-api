import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLTier } from '../object/Tier';

export const GraphQLTierCollection = new GraphQLObjectType({
  name: 'TierCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Tiers"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLTier),
      },
    };
  },
});
