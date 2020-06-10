import { GraphQLInputObjectType, GraphQLInt } from 'graphql';

export const TierReferenceInput = new GraphQLInputObjectType({
  name: 'TierReferenceInput',
  fields: () => ({
    legacyId: {
      type: GraphQLInt,
      description: 'The legacy id assigned to the Tier',
    },
  }),
});
