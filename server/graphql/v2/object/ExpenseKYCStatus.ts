import { GraphQLEnumType, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { GraphQLKYCVerification } from './KYCVerification';

export const GraphQLExpenseKYCStatus = new GraphQLObjectType({
  name: 'ExpenseKYCStatus',
  fields: () => ({
    payee: { type: GraphQLExpensePayeeKYC },
  }),
});

const GraphQLExpensePayeeKYCType = new GraphQLEnumType({
  name: 'ExpensePayeeKYCType',
  description: 'Whether the payee is an individual (its own KYC) or a multi-admin account (rollup over admin KYC)',
  values: {
    INDIVIDUAL: { value: 'INDIVIDUAL' },
    ACCOUNT: { value: 'ACCOUNT' },
  },
});

const GraphQLExpensePayeeKYC = new GraphQLObjectType({
  name: 'ExpensePayeeKYC',
  fields: () => ({
    type: {
      type: GraphQLExpensePayeeKYCType,
      description:
        'Whether the payee is an individual or a multi-admin account (Organization, Collective, Project, Event, Fund, Vendor)',
    },
    status: {
      type: new GraphQLEnumType({
        name: 'ExpensePayeeKYCStatus',
        values: {
          NOT_REQUESTED: { value: 'NOT_REQUESTED' },
          PENDING: { value: 'PENDING' },
          VERIFIED: { value: 'VERIFIED' },
        },
      }),
    },
    adminVerifications: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLKYCVerification)),
    },
  }),
});
