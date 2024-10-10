import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON, GraphQLNonEmptyString } from 'graphql-scalars';

import TransactionsImportRow from '../../../models/TransactionsImportRow';
import { GraphQLTransactionsImportRowCollection } from '../collection/GraphQLTransactionsImportRow';
import { GraphQLTransactionsImportType } from '../enum/TransactionsImportType';
import { getIdEncodeResolver } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLFileInfo } from '../interface/FileInfo';

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
    rows: {
      type: new GraphQLNonNull(GraphQLTransactionsImportRowCollection),
      description: 'List of rows in the import',
      resolve: async importInstance => {
        const where = { TransactionsImportId: importInstance.id };
        return {
          offset: 0,
          limit: 1000000, // TODO: pagination
          totalCount: () => TransactionsImportRow.count({ where }),
          nodes: () =>
            TransactionsImportRow.findAll({
              where,
              order: [
                ['createdAt', 'ASC'],
                ['id', 'ASC'],
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
