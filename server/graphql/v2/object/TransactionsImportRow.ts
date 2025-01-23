import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
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
    isDismissed: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the row has been dismissed',
      deprecationReason: '2025-01-17: isDismissed is deprecated, use status instead',
      resolve: (row: TransactionsImportRow) => row.status === 'IGNORED',
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
  }),
});
