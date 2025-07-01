import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { GraphQLConnectedAccount } from './ConnectedAccount';
import { GraphQLTransactionsImport } from './TransactionsImport';

export const GraphQLGoCardlessConnectAccountResponse = new GraphQLObjectType({
  name: 'GoCardlessConnectAccountResponse',
  fields: {
    connectedAccount: {
      type: new GraphQLNonNull(GraphQLConnectedAccount),
      description: 'The connected account that was created',
    },
    transactionsImport: {
      type: new GraphQLNonNull(GraphQLTransactionsImport),
      description: 'The transactions import that was created',
    },
  },
});
