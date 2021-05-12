import { GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLJSONObject } from 'graphql-type-json';

export const VirtualCardInput = new GraphQLInputObjectType({
  name: 'VirtualCardInput',
  fields: () => ({
    id: { type: GraphQLString },
    name: { type: GraphQLString },
    last4: { type: GraphQLString },
    data: { type: GraphQLJSONObject },
    privateData: { type: GraphQLJSONObject },
  }),
});

export const VirtualCardUpdateInput = new GraphQLInputObjectType({
  name: 'VirtualCardUpdateInput',
  fields: () => ({
    id: { type: GraphQLString },
    privateData: { type: GraphQLJSONObject },
  }),
});
