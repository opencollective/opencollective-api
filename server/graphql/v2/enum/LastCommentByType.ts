import { GraphQLEnumType } from 'graphql';

export const GraphQLLastCommentBy = new GraphQLEnumType({
  name: `LastCommentBy`,
  description: 'Defines role of the last comment author',
  values: {
    USER: { value: 'USER', description: 'Expense Submitter' },
    NON_FROM_ACCOUNT_ADMIN: {
      value: 'NON_FROM_ACCOUNT_ADMIN',
      description: 'Last comment author is not an admin of the expense payee (FromCollectiveId)',
    },
    HOST_ADMIN: { value: 'HOST_ADMIN', description: 'Fiscal Host Admin' },
    NON_HOST_ADMIN: { value: 'NON_HOST_ADMIN', description: 'Not a Fiscal Host Admin' },
    COLLECTIVE_ADMIN: { value: 'COLLECTIVE_ADMIN', description: 'Collective Admin' },
  },
});
