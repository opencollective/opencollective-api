import { GraphQLEnumType } from 'graphql';

export const GraphQLLastCommentBy = new GraphQLEnumType({
  name: `LastCommentBy`,
  description: 'Defines role of the last comment author',
  values: {
    USER: { value: 'USER', description: 'Expense Submitter' },
    HOST_ADMIN: { value: 'HOST_ADMIN', description: 'Fiscal Host Admin' },
    COLLECTIVE_ADMIN: { value: 'COLLECTIVE_ADMIN', description: 'Collective Admin' },
  },
});
