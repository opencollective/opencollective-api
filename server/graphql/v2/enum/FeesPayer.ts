import { GraphQLEnumType } from 'graphql';

export const FeesPayer = new GraphQLEnumType({
  name: 'FeesPayer',
  description: 'All supported expense types',
  values: {
    COLLECTIVE: {
      description: 'The collective will be responsible for paying the fees',
    },
    PAYEE: {
      description: "The payee will be responsible for paying the fees (they'll be deduced from the total amount)",
    },
  },
});
