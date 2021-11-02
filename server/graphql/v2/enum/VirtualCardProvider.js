import { GraphQLEnumType } from 'graphql';

export const VirtualCardProvider = new GraphQLEnumType({
  name: 'VirtualCardProvider',
  values: {
    PRIVACY: {},
    STRIPE: {},
  },
});
