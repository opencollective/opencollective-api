import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
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
import { GraphQLTransactionsImportStats } from './OffPlatformTransactionsStats';
import { GraphQLPlaidAccount } from './PlaidAccount';
import { GraphQLTransactionsImportAssignment } from './TransactionsImportAssignment';

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
    plaidAccounts: {
      type: new GraphQLList(GraphQLPlaidAccount),
      description: 'List of available accounts for the import',
      resolve: (importInstance: TransactionsImport) => importInstance.data?.plaid?.availableAccounts || null,
    },
    assignments: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImportAssignment))),
      description:
        'Assignments for the import, as a map of account id to legacy collective IDs. The `__default__` key can be use to set the default assignment.',
      resolve: (importInstance: TransactionsImport, _, req) => {
        const assignments = importInstance.settings?.assignments || {};
        return Object.entries(assignments).map(([importedAccountId, accountIds]) => ({
          importedAccountId,
          accounts: () => req.loaders.Collective.byId.loadMany(accountIds),
        }));
      },
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
      deprecationReason: '2025-04-29: Please use `host.offPlatformTransactions` instead.',
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
        accountId: {
          type: new GraphQLList(GraphQLNonEmptyString),
          description: 'Filter rows by plaid account id',
        },
      },
      resolve: async (
        importInstance,
        args: {
          limit: number;
          offset: number;
          status: TransactionsImportRowStatus;
          searchTerm: string;
          accountId: string[];
        },
      ) => {
        const where: Parameters<typeof TransactionsImportRow.findAll>[0]['where'] = {
          [Op.and]: [{ TransactionsImportId: importInstance.id }],
        };

        // Filter by status
        if (args.status) {
          where[Op.and].push({ status: args.status });
        }

        // Search term
        if (args.searchTerm) {
          where[Op.and].push({
            [Op.or]: buildSearchConditions(args.searchTerm, {
              textFields: ['description', 'sourceId'],
            }),
          });
        }

        // Filter by plaid account id
        if (args.accountId?.length) {
          // eslint-disable-next-line camelcase
          where[Op.and].push({ rawValue: { account_id: { [Op.in]: args.accountId } } });
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
      type: new GraphQLNonNull(GraphQLTransactionsImportStats),
      resolve: async (importInstance, _, req: Express.Request) => {
        return req.loaders.TransactionsImport.stats.load(importInstance.id);
      },
    },
  }),
});
