import { GraphQLInputObjectType, GraphQLString } from 'graphql';

export const GraphQLVirtualCardRequestReferenceInput = new GraphQLInputObjectType({
  name: 'VirtualCardRequestReferenceInput',
  fields: () => ({
    id: { type: GraphQLString },
  }),
});
