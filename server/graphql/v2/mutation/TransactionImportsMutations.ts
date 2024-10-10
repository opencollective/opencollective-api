import config from 'config';
import type { Request } from 'express';
import { GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLJSONObject, GraphQLNonEmptyString } from 'graphql-scalars';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import { isUndefined, omit, omitBy } from 'lodash';

import RateLimit from '../../../lib/rate-limit';
import { sequelize, TransactionsImport, TransactionsImportRow, UploadedFile } from '../../../models';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';
import { GraphQLTransactionsImportType } from '../enum/TransactionsImportType';
import { idDecode } from '../identifiers';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../input/AmountInput';
import { getDatabaseIdFromOrderReference } from '../input/OrderReferenceInput';
import { GraphQLTransactionsImportRowCreateInput } from '../input/TransactionsImportRowCreateInput';
import { GraphQLTransactionsImportRowUpdateInput } from '../input/TransactionsImportRowUpdateInput';
import { GraphQLTransactionsImport } from '../object/TransactionsImport';

const transactionImportsMutations = {
  createTransactionsImport: {
    type: new GraphQLNonNull(GraphQLTransactionsImport),
    description: 'Create a new import. To manually add transactions to it, use `importTransactions`.',
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account that will hold the import (usually the host)',
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
    },
    resolve: async (_: void, args, req: Request) => {
      checkRemoteUserCanUseTransactions(req);
      const account = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollective(account)) {
        throw new Unauthorized('You need to be an admin of the account to create an import');
      } else if (!account.isHostAccount) {
        throw new Error('Only host accounts can have imports');
      }

      // Create the import
      return TransactionsImport.createWithActivity(
        req.remoteUser,
        account,
        {
          source: args.source,
          name: args.name,
          type: args.type,
        },
        {
          UserTokenId: req.userToken?.id,
        },
      );
    },
  },
  importTransactions: {
    type: new GraphQLNonNull(GraphQLTransactionsImport),
    description: 'Import transactions, manually or from a CSV file',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'ID of the import to add transactions to',
      },
      file: {
        type: GraphQLUpload,
        description: 'Raw file from which the data was extracted',
      },
      csvConfig: {
        type: GraphQLJSONObject,
        description: 'Configuration of the CSV file',
      },
      data: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImportRowCreateInput))),
        description: 'Data to import',
      },
    },
    resolve: async (_: void, args, req: Request) => {
      checkRemoteUserCanUseTransactions(req);
      const importId = idDecode(args.id, 'transactions-import');
      const importInstance = await TransactionsImport.findByPk(importId, { include: [{ association: 'collective' }] });
      const maxRows = config.limits.transactionsImports.rowsPerHourPerUser;
      if (!importInstance) {
        throw new NotFound(`Import not found: ${args.id}`);
      } else if (!req.remoteUser.isAdminOfCollective(importInstance.collective)) {
        throw new Unauthorized('You need to be an admin of the account to import transactions');
      } else if (args.file && !args.csvConfig) {
        throw new ValidationFailed('You must provide a CSV configuration when importing from a file');
      } else if (args.data.length === 0) {
        throw new ValidationFailed('You must provide at least one row to import');
      } else if (args.data.length > maxRows) {
        throw new ValidationFailed(`You can import up to ${maxRows} at once`);
      }

      // Rate rate limit on the number of rows imported per hour
      const rateLimitRows = new RateLimit(`transactions-imports-rows-${req.remoteUser.id}`, maxRows);
      if (await rateLimitRows.hasReachedLimit()) {
        throw new RateLimitExceeded('You have reached the limit of transactions imports rows per hour');
      }

      // Rate limit on the number of imports per hour
      const maxImportsPerHour = config.limits.transactionsImports.perHourPerUser;
      const rateLimit = new RateLimit(`transactions-imports-${req.remoteUser.id}`, maxImportsPerHour);
      if (await rateLimit.hasReachedLimit()) {
        throw new RateLimitExceeded('You have reached the limit of transactions imports per hour');
      }

      // Handle CSV
      let file;
      if (args.file) {
        file = await UploadedFile.uploadGraphQl(await args.file, 'TRANSACTIONS_IMPORT', req.remoteUser, {
          supportedMimeTypes: ['text/csv'],
        });
      }

      // Register rate limit call as soon as the file is uploaded
      rateLimit.registerCall();

      return sequelize.transaction(async transaction => {
        if (file || args.csvConfig) {
          await importInstance.update(
            {
              UploadedFileId: file?.id,
              settings: { csvConfig: args.csvConfig },
              lastSyncAt: new Date(),
            },
            { transaction },
          );
        }

        await importInstance.addRows(
          args.data.map(row => ({
            ...row,
            amount: getValueInCentsFromAmountInput(row.amount),
            currency: row.amount.currency,
          })),
          { transaction },
        );

        return importInstance;
      });
    },
  },
  updateTransactionsImportRows: {
    type: new GraphQLNonNull(GraphQLTransactionsImport),
    description: 'Update transactions import rows to set new values or mark them as dismissed',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'ID of the import to add transactions to',
      },
      rows: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImportRowUpdateInput))),
        description: 'Rows to update',
      },
    },
    resolve: async (_: void, args, req: Request) => {
      checkRemoteUserCanUseTransactions(req);
      const importId = idDecode(args.id, 'transactions-import');
      const transactionsImport = await TransactionsImport.findByPk(importId, {
        include: [{ association: 'collective' }],
      });
      if (!transactionsImport) {
        throw new NotFound('Import not found');
      } else if (!req.remoteUser.isAdminOfCollective(transactionsImport.collective)) {
        throw new Unauthorized('You need to be an admin of the account to update a row');
      }

      // Preload orders
      return sequelize.transaction(async transaction => {
        // Update rows
        await Promise.all(
          args.rows.map(async row => {
            const rowId = idDecode(row.id, 'transactions-import-row');
            const values = omitBy(omit(row, ['id', 'order']), isUndefined);
            if (row.amount) {
              values.amount = getValueInCentsFromAmountInput(row.amount);
              values.currency = row.amount.currency;
            }
            if (row.order) {
              const orderId = getDatabaseIdFromOrderReference(row.order);
              const order = await req.loaders.Order.byId.load(orderId);
              const collective = order && (await req.loaders.Collective.byId.load(order.CollectiveId));
              if (!order || !collective || collective.HostCollectiveId !== transactionsImport.CollectiveId) {
                throw new Unauthorized(`Order not found or not associated with the import: ${orderId}`);
              }

              values['OrderId'] = order.id;
            }

            const [updatedCount] = await TransactionsImportRow.update(values, {
              where: { id: rowId, TransactionsImportId: importId },
              transaction,
            });

            if (!updatedCount) {
              throw new NotFound(`Row not found: ${row.id}`);
            }
          }),
        );

        // Update import
        return transactionsImport.update({ updatedAt: new Date() }, { transaction });
      });
    },
  },
};

export default transactionImportsMutations;
