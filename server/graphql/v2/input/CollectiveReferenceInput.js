import { GraphQLInputObjectType, GraphQLString } from 'graphql';

/**
 * An input for referencing Collectives.
 */
export const CollectiveReferenceInput = new GraphQLInputObjectType({
  name: 'CollectiveReferenceInput',
  fields: {
    id: {
      type: GraphQLString,
      description: 'The public id identifying the collective',
    },
  },
});
