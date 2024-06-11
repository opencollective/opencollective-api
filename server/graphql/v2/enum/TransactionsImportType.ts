import { GraphQLEnumType } from 'graphql';

export const GraphQLTransactionsImportType = new GraphQLEnumType({
  name: 'TransactionsImportType',
  description: 'Type of the import',
  values: {
    CSV: { value: 'CSV' },
    MANUAL: { value: 'MANUAL' },
  },
});
