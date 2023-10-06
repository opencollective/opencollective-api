import { GraphQLEnumType } from 'graphql';

export const GraphQLExpenseCurrencySource = new GraphQLEnumType({
  name: 'ExpenseCurrencySource',
  description: 'All supported expense currency sources',
  values: {
    HOST: {
      description: 'The expense currency expressed as the host currency',
    },
    ACCOUNT: {
      description: 'The expense currency expressed as the account currency',
    },
    EXPENSE: {
      description: 'The expense currency expressed as the expense currency',
    },
    CREATED_BY_ACCOUNT: {
      description: 'The expense currency expressed as the expense currency',
    },
  },
});
