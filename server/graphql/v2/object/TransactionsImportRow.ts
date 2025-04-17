import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSONObject, GraphQLNonEmptyString } from 'graphql-scalars';

import { TransactionsImportRow } from '../../../models';
import { GraphQLTransactionsImportRowStatus } from '../enum/TransactionsImportRowStatus';
import { getIdEncodeResolver } from '../identifiers';

import { GraphQLAmount } from './Amount';
import { GraphQLExpense } from './Expense';
import { GraphQLOrder } from './Order';

export const GraphQLTransactionsImportRow = new GraphQLObjectType({
  name: 'TransactionsImportRow',
  description: 'A row in a transactions import',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id of the imported row',
      resolve: getIdEncodeResolver('transactions-import-row'),
    },
    sourceId: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The source id of the row',
    },
    status: {
      type: new GraphQLNonNull(GraphQLTransactionsImportRowStatus),
      description: 'The status of the row',
    },
    description: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The description of the row',
    },
    date: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date of the row',
    },
    amount: {
      type: new GraphQLNonNull(GraphQLAmount),
      description: 'The amount of the row',
      resolve: (row: TransactionsImportRow) => ({ value: row.amount, currency: row.currency }),
    },
    note: {
      type: GraphQLString,
      description: 'Optional note for the row',
    },
    expense: {
      type: GraphQLExpense,
      description: 'The expense associated with the row',
      resolve: async (row: TransactionsImportRow, _, req) => {
        if (row.ExpenseId) {
          return req.loaders.Expense.byId.load(row.ExpenseId);
        }
      },
    },
    accountId: {
      type: GraphQLString,
      description:
        'If an account ID is available in the imported row, it will be stored here. Returns the default account ID otherwise.',
      // "__default__" must match `components/dashboard/sections/transactions-imports/lib/types.ts`
      resolve: (row: TransactionsImportRow) => row.rawValue?.['account_id'] || '__default__',
    },
    rawValue: {
      type: GraphQLJSONObject,
      description: 'The raw data of the row',
    },
    order: {
      type: GraphQLOrder,
      description: 'The order associated with the row',
      resolve: async (row: TransactionsImportRow, _, req) => {
        if (row.OrderId) {
          return req.loaders.Order.byId.load(row.OrderId);
        }
      },
    },
    transactionsImport: {
      type: new GraphQLNonNull(GraphQLTransactionsImportRow),
      description: 'The transactions import associated with the row',
      resolve: async (row: TransactionsImportRow, _, req) => {
        return req.loaders.TransactionsImport.byId.load(row.TransactionsImportId);
      },
    },
  }),
});
