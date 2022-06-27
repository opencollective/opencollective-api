import { GraphQLInputObjectType, GraphQLString } from 'graphql';

export const VirtualCardReferenceInput = new GraphQLInputObjectType({
  name: 'VirtualCardReferenceInput',
  fields: () => ({
    id: { type: GraphQLString },
  }),
});
