import { GraphQLEnumType } from 'graphql';

export const GraphQLTransactionType = new GraphQLEnumType({
  name: 'TransactionType',
  description: 'All transaction types',
  values: {
    DEBIT: {},
    CREDIT: {},
  },
});
