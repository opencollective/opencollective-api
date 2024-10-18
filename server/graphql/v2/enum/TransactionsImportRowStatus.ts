import { GraphQLEnumType } from 'graphql';

export enum TransactionsImportRowStatus {
  PENDING = 'PENDING',
  LINKED = 'LINKED',
  IGNORED = 'IGNORED',
}

export const GraphQLTransactionsImportRowStatus = new GraphQLEnumType({
  name: 'TransactionsImportRowStatus',
  description: 'The status of a row in a transactions import',
  values: {
    PENDING: { value: 'PENDING', description: 'The row has not been processed yet' },
    LINKED: { value: 'LINKED', description: 'The row has been linked to an existing expense or order' },
    IGNORED: { value: 'IGNORED', description: 'The row has been ignored' },
  },
});
