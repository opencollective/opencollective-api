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

export const VirtualCardEditInput = new GraphQLInputObjectType({
  name: 'VirtualCardEditInput',
  fields: () => ({
    id: { type: GraphQLString },
    privateData: { type: GraphQLJSONObject },
  }),
});
