import { GraphQLEnumType } from 'graphql';

const GraphQLExpenseKYCStatusFilter = new GraphQLEnumType({
  name: 'ExpenseKYCStatusFilter',
  description: 'Describes the values allowed to filter expenses KYC statuses, namely all the KYC statuses.',
  values: {
    VERIFIED: { value: 'VERIFIED' },
    PENDING: { value: 'PENDING' },
  },
});

export default GraphQLExpenseKYCStatusFilter;
