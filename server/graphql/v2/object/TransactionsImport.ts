import { GraphQLBoolean, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';

import { buildSearchConditions } from '../../../lib/sql-search';
import { Op, TransactionsImport } from '../../../models';
import TransactionsImportRow from '../../../models/TransactionsImportRow';
import { GraphQLTransactionsImportRowCollection } from '../collection/GraphQLTransactionsImportRow';
import { GraphQLTransactionsImportRowStatus, TransactionsImportRowStatus } from '../enum/TransactionsImportRowStatus';
import { GraphQLTransactionsImportType } from '../enum/TransactionsImportType';
import { getIdEncodeResolver } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { getCollectionArgs } from '../interface/Collection';
import { GraphQLFileInfo } from '../interface/FileInfo';

import { GraphQLConnectedAccount } from './ConnectedAccount';

export const GraphQLTransactionsImport = new GraphQLObjectType({
  name: 'TransactionsImport',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The public id of the import',
      resolve: getIdEncodeResolver('transactions-import'),
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccount),
      description: 'Account that holds the import',
      resolve: async (importInstance, _, req) => {
        return req.loaders.Collective.byId.load(importInstance.CollectiveId);
      },
    },
    file: {
      type: GraphQLFileInfo,
      description: 'URL of the import (e.g. link to the CSV file)',
      resolve: async (importInstance, _, req) => {
        if (importInstance.UploadedFileId) {
          return req.loaders.UploadedFile.byId.load(importInstance.UploadedFileId);
        }
      },
    },
    source: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'Source of the import (e.g. "Bank of America", "Eventbrite", etc...)',
    },
    name: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'Name of the import (e.g. "Contributions May 2021", "Tickets for Mautic Conference 2024")',
    },
    type: {
      type: new GraphQLNonNull(GraphQLTransactionsImportType),
      description: 'Type of the import',
    },
    csvConfig: {
      type: GraphQLJSON,
      description: 'Configuration for the CSV import',
      resolve: importInstance => importInstance.settings?.csvConfig,
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'When the import was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'When the import was last updated',
    },
    lastSyncAt: {
      type: GraphQLDateTime,
      description: 'When the import was last synced',
    },
    isSyncing: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Whether the import is currently syncing',
      resolve: (importInstance: TransactionsImport) => Boolean(importInstance.data?.lockedAt),
    },
    lastSyncCursor: {
      type: GraphQLString,
      description: 'Cursor that defines where the last sync left off. Useful to know if there is new data to sync',
      resolve: (importInstance: TransactionsImport) => importInstance.data?.plaid?.lastSyncCursor,
    },
    connectedAccount: {
      type: GraphQLConnectedAccount,
      description: 'Connected account linked to the import',
      resolve: (importInstance, _, req) => {
        if (importInstance.ConnectedAccountId) {
          return req.loaders.ConnectedAccount.byId.load(importInstance.ConnectedAccountId);
        }
      },
    },
    rows: {
      type: new GraphQLNonNull(GraphQLTransactionsImportRowCollection),
      description: 'List of rows in the import',
      args: {
        ...getCollectionArgs({ limit: 100 }),
        status: {
          type: GraphQLTransactionsImportRowStatus,
          description: 'Filter rows by status',
        },
        searchTerm: {
          type: GraphQLString,
          description: 'Search by text',
        },
      },
      resolve: async (
        importInstance,
        args: { limit: number; offset: number; status: TransactionsImportRowStatus; searchTerm: string },
      ) => {
        const where: Parameters<typeof TransactionsImportRow.findAll>[0]['where'] = {
          [Op.and]: [{ TransactionsImportId: importInstance.id }],
        };

        // Filter by status
        if (args.status) {
          if (args.status === 'IGNORED') {
            where[Op.and].push({ isDismissed: true });
          } else if (args.status === 'LINKED') {
            where[Op.and].push({ [Op.or]: [{ ExpenseId: { [Op.not]: null } }, { OrderId: { [Op.not]: null } }] });
          } else if (args.status === 'PENDING') {
            where[Op.and].push({ ExpenseId: null }, { OrderId: null }, { isDismissed: false });
          }
        }

        // Search term
        if (args.searchTerm) {
          where[Op.and].push({
            [Op.or]: buildSearchConditions(args.searchTerm, {
              textFields: ['description', 'sourceId'],
            }),
          });
        }

        return {
          offset: args.offset,
          limit: args.limit,
          totalCount: () => TransactionsImportRow.count({ where }),
          nodes: () =>
            TransactionsImportRow.findAll({
              where,
              limit: args.limit,
              offset: args.offset,
              order: [
                ['date', 'DESC'],
                ['createdAt', 'DESC'],
                ['id', 'DESC'],
              ],
            }),
        };
      },
    },
    stats: {
      type: new GraphQLObjectType({
        name: 'TransactionsImportStats',
        fields: {
          total: {
            type: new GraphQLNonNull(GraphQLInt),
            description: 'Total number of rows in the import',
          },
          ignored: {
            type: new GraphQLNonNull(GraphQLInt),
            description: 'Number of rows that have been ignored',
          },
          expenses: {
            type: new GraphQLNonNull(GraphQLInt),
            description: 'Number of rows that have been converted to expenses',
          },
          orders: {
            type: new GraphQLNonNull(GraphQLInt),
            description: 'Number of rows that have been converted to orders',
          },
          processed: {
            type: new GraphQLNonNull(GraphQLInt),
            description:
              'Number of rows that have been processed (either dismissed or converted to expenses or orders)',
          },
        },
      }),
      resolve: async (importInstance, _, req) => {
        return req.loaders.TransactionsImport.stats.load(importInstance.id);
      },
    },
  }),
});
