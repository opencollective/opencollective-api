import { GraphQLEnumType } from 'graphql';

export const GraphQLProcessHostApplicationAction = new GraphQLEnumType({
  name: 'ProcessHostApplicationAction',
  description: 'Action taken for an account application to the host',
  values: {
    APPROVE: { description: 'Approve the account request to be hosted' },
    REJECT: { description: 'Rejects the account request to be hosted' },
    SEND_PRIVATE_MESSAGE: { description: 'Sends a private message to the admins of the account' },
    SEND_PUBLIC_MESSAGE: { description: 'Creates a public conversation' },
  },
});
