import { GraphQLEnumType } from 'graphql';

export const GraphQLVirtualCardProvider = new GraphQLEnumType({
  name: 'VirtualCardProvider',
  values: {
    PRIVACY: {},
    STRIPE: {},
  },
});
