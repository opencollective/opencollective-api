import { GraphQLEnumType } from 'graphql';

import { TransactionsImportTypes } from '../../../models/TransactionsImport';

export const GraphQLTransactionsImportType = new GraphQLEnumType({
  name: 'TransactionsImportType',
  description: 'Type of the import',
  values: TransactionsImportTypes.reduce((acc, type) => ({ ...acc, [type]: { value: type } }), {}),
});
