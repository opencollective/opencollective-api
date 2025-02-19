import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLTransactionsImportAssignmentInput = new GraphQLInputObjectType({
  name: 'TransactionsImportAssignmentInput',
  fields: () => ({
    importedAccountId: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The ID of the account to assign the transactions to',
    },
    accounts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput))),
      description: 'The accounts to assign the transactions to',
    },
  }),
});
