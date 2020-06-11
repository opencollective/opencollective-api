import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { Tier } from '../object/Tier';

export const TierCollection = new GraphQLObjectType({
  name: 'TierCollection',
  interfaces: [Collection],
  description: 'A collection of "Tiers"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(Tier),
      },
    };
  },
});
