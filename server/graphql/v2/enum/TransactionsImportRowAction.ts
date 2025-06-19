import { GraphQLEnumType } from 'graphql';

export const TransactionsImportRowActionTypes = [
  'DISMISS_ALL',
  'RESTORE_ALL',
  'PUT_ON_HOLD_ALL',
  'UPDATE_ROWS',
] as const;

export const GraphQLTransactionsImportRowAction = new GraphQLEnumType({
  name: 'TransactionsImportRowAction',
  description: 'Action to perform on transactions import rows',
  values: TransactionsImportRowActionTypes.reduce((acc, type) => ({ ...acc, [type]: { value: type } }), {}),
});
