import { GraphQLEnumType } from 'graphql';

export const GraphQLCommunityRelationType = new GraphQLEnumType({
  name: 'CommunityRelationType',
  values: {
    ADMIN: { value: 'ADMIN' },
    ATTENDEE: { value: 'ATTENDEE' },
    PAYEE: { value: 'PAYEE' },
    GRANTEE: { value: 'GRANTEE' },
    CONTRIBUTOR: { value: 'CONTRIBUTOR' },
    EXPENSE_SUBMITTER: { value: 'EXPENSE_SUBMITTER' },
    EXPENSE_APPROVER: { value: 'EXPENSE_APPROVER' },
  },
});
