import { GraphQLEnumType } from 'graphql';

export const GraphQLOffPlatformTransactionsProvider = new GraphQLEnumType({
  name: 'OffPlatformTransactionsProvider',
  description: 'Provider for off-platform transactions',
  values: {
    GOCARDLESS: {
      description: 'GoCardless bank account data provider',
    },
    PLAID: {
      description: 'Plaid bank account data provider',
    },
  },
});
