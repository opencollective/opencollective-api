import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { GraphQLAccount } from '../interface/Account';

export const GraphQLTransactionsImportAssignment = new GraphQLObjectType({
  name: 'TransactionsImportAssignment',
  fields: () => ({
    importedAccountId: { type: new GraphQLNonNull(GraphQLNonEmptyString) },
    accounts: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAccount))) },
  }),
});
