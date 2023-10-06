import { GraphQLInputObjectType, GraphQLString } from 'graphql';

export const GraphQLVirtualCardReferenceInput = new GraphQLInputObjectType({
  name: 'VirtualCardReferenceInput',
  fields: () => ({
    id: { type: GraphQLString },
  }),
});
