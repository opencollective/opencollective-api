import { GraphQLObjectType, GraphQLString } from 'graphql';

export const GraphQLWhitelabelProvider = new GraphQLObjectType({
  name: 'WhitelabelProvider',
  description: 'A Virtual Card used to pay expenses',
  fields: () => ({
    domain: { type: GraphQLString },
    logo: { type: GraphQLString },
  }),
});
