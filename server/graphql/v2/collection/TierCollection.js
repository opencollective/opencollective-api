import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLTier } from '../object/Tier.js';

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
