import { GraphQLEnumType, GraphQLObjectType } from 'graphql';

export const GraphQLExpenseKYCStatus = new GraphQLObjectType({
  name: 'ExpenseKYCStatus',
  fields: () => ({
    payee: { type: GraphQLExpensePayeeKYC },
  }),
});

const GraphQLExpensePayeeKYC = new GraphQLObjectType({
  name: 'ExpensePayeeKYC',
  fields: () => ({
    status: {
      description: 'Expense payee KYC status',
      type: new GraphQLEnumType({
        name: 'ExpensePayeeKYCStatus',
        values: {
          NOT_REQUESTED: { value: 'NOT_REQUESTED' },
          PENDING: { value: 'PENDING' },
          VERIFIED: { value: 'VERIFIED' },
        },
      }),
    },
  }),
});
