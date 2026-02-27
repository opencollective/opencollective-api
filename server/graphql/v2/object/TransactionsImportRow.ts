import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSONObject, GraphQLNonEmptyString } from 'graphql-scalars';

import { TransactionsImportRow } from '../../../models';
import { GraphQLTransactionsImportRowStatus } from '../enum/TransactionsImportRowStatus';
import { getIdEncodeResolver } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

import { GraphQLAmount } from './Amount';
import { GraphQLExpense } from './Expense';
import { GraphQLOrder } from './Order';
import { GraphQLPlaidAccount } from './PlaidAccount';
import { GraphQLTransactionsImport } from './TransactionsImport';
import { GraphQLTransactionsImportAccount } from './TransactionsImportAccount';

export const GraphQLTransactionsImportRow = new GraphQLObjectType({
  name: 'TransactionsImportRow',
  description: 'A row in a transactions import',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id of the imported row',
      deprecationReason: '2026-02-25: use publicId',
      resolve: getIdEncodeResolver('transactions-import-row'),
    },
    publicId: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The resource public id (ie: ${TransactionsImportRow.nanoIdPrefix}_xxxxxxxx)`,
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
      resolve: (row: TransactionsImportRow) => row.accountId || '__default__',
    },
    plaidAccount: {
      type: GraphQLPlaidAccount,
      description: 'If the row was imported from plaid, this is the account it was imported from',
      deprecationReason: '2025-07-02: Please use the generic institutionAccount field instead.',
      resolve: async (row: TransactionsImportRow, _, req) => {
        const accountId = row.accountId;
        if (accountId) {
          const transactionsImport =
            row.import || (await req.loaders.TransactionsImport.byId.load(row.TransactionsImportId));
          if (transactionsImport && transactionsImport.data?.plaid) {
            const matchingPlaidAccount = transactionsImport.data.plaid.availableAccounts?.find(
              plaidAccount => plaidAccount.accountId === accountId,
            );

            if (matchingPlaidAccount) {
              return matchingPlaidAccount;
            }
          }

          // Fallback
          return {
            accountId: accountId,
            mask: '',
            name: '',
            officialName: '',
            subtype: '',
            type: '',
          };
        }
      },
    },
    institutionAccount: {
      type: GraphQLTransactionsImportAccount,
      description: 'Corresponding account for the row, based on its account ID',
      resolve: async (row: TransactionsImportRow, _, req) => {
        const accountId = row.accountId;
        if (!accountId) {
          return null;
        }

        const importInstance = await req.loaders.TransactionsImport.byId.load(row.TransactionsImportId);
        if (importInstance.type === 'PLAID') {
          const matchingPlaidAccount = importInstance.data?.plaid?.availableAccounts?.find(
            plaidAccount => plaidAccount.accountId === accountId,
          );
          if (matchingPlaidAccount) {
            return {
              id: matchingPlaidAccount.accountId,
              name: matchingPlaidAccount.name,
              subtype: matchingPlaidAccount.subtype,
              type: matchingPlaidAccount.type,
              mask: matchingPlaidAccount.mask,
            };
          }
        } else if (importInstance.type === 'GOCARDLESS') {
          const matchingGoCardlessAccount = importInstance.data?.gocardless?.accountsMetadata?.find(
            account => account.id === accountId,
          );
          if (matchingGoCardlessAccount) {
            return {
              id: matchingGoCardlessAccount.id,
              name: matchingGoCardlessAccount.name || 'Account',
            };
          }
        }

        return null;
      },
    },
    assignedAccounts: {
      type: new GraphQLNonNull(new GraphQLList(GraphQLAccount)),
      description: 'The accounts assigned to the row, based on its account ID',
      resolve: async (row: TransactionsImportRow, _, req) => {
        const transactionsImport = await req.loaders.TransactionsImport.byId.load(row.TransactionsImportId);
        const assignments = transactionsImport.settings?.assignments || {};
        const accountId = row.accountId || '__default__';
        if (!assignments[accountId]?.length) {
          return [];
        }

        return req.loaders.Collective.byId.loadMany(assignments[accountId]);
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
    transactionsImport: {
      type: new GraphQLNonNull(GraphQLTransactionsImport),
      description: 'The transactions import associated with the row',
      resolve: async (row: TransactionsImportRow, _, req) => {
        return req.loaders.TransactionsImport.byId.load(row.TransactionsImportId);
      },
    },
  }),
});
