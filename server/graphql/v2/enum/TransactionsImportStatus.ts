import { GraphQLEnumType } from 'graphql';

export const GraphQLTransactionsImportStatus = new GraphQLEnumType({
  name: 'TransactionsImportStatus',
  description: 'Status of the import',
  values: {
    ACTIVE: { description: 'The import is connected and ready to sync' },
    DISCONNECTED: { description: 'The import is disconnected / archived' },
  },
});
