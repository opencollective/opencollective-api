import config from 'config';
import type { Request } from 'express';
import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLJSONObject, GraphQLNonEmptyString } from 'graphql-scalars';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import { isEmpty, keyBy, mapValues, omit, pick } from 'lodash';

import { disconnectPlaidAccount } from '../../../lib/plaid/connect';
import RateLimit from '../../../lib/rate-limit';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import {
  ConnectedAccount,
  Op,
  sequelize,
  TransactionsImport,
  TransactionsImportRow,
  UploadedFile,
} from '../../../models';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { NotFound, RateLimitExceeded, Unauthorized, ValidationFailed } from '../../errors';
import {
  GraphQLTransactionsImportRowAction,
  TransactionsImportRowActionTypes,
} from '../enum/TransactionsImportRowAction';
import { GraphQLTransactionsImportType } from '../enum/TransactionsImportType';
import { idDecode } from '../identifiers';
import {
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../input/AmountInput';
import { fetchExpenseWithReference } from '../input/ExpenseReferenceInput';
import { getDatabaseIdFromOrderReference } from '../input/OrderReferenceInput';
import { GraphQLTransactionsImportAssignmentInput } from '../input/TransactionsImportAssignmentInput';
import { GraphQLTransactionsImportRowCreateInput } from '../input/TransactionsImportRowCreateInput';
import {
  GraphQLTransactionsImportRowUpdateInput,
  TransactionImportRowGraphQLType,
} from '../input/TransactionsImportRowUpdateInput';
import { GraphQLTransactionsImport } from '../object/TransactionsImport';
import { GraphQLTransactionsImportRow } from '../object/TransactionsImportRow';

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
  editTransactionsImport: {
    type: new GraphQLNonNull(GraphQLTransactionsImport),
    description: 'Edit an import',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'ID of the import to edit',
      },
      source: {
        type: GraphQLNonEmptyString,
        description: 'Source of the import (e.g. "Bank of America", "Eventbrite", etc...)',
      },
      name: {
        type: GraphQLNonEmptyString,
        description: 'Name of the import (e.g. "Contributions May 2021", "Tickets for Mautic Conference 2024")',
      },
      assignments: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImportAssignmentInput)),
        description: 'Assignments for the import',
      },
    },
    resolve: async (_: void, args, req: Request) => {
      checkRemoteUserCanUseTransactions(req);
      const importId = idDecode(args.id, 'transactions-import');
      const importInstance = await TransactionsImport.findByPk(importId, { include: [{ association: 'collective' }] });
      if (!importInstance) {
        throw new NotFound('Import not found');
      } else if (!req.remoteUser.isAdminOfCollective(importInstance.collective)) {
        throw new Unauthorized('You need to be an admin of the account to edit an import');
      }

      const newValues = pick(args, ['source', 'name']);
      if (args.assignments) {
        const loadedAssignments = await Promise.all(
          args.assignments.map(async assignment => ({
            ...assignment,
            accounts: await fetchAccountsWithReferences(assignment.accounts, {
              throwIfMissing: true,
              attributes: ['id', 'HostCollectiveId'],
            }),
          })),
        );

        if (
          loadedAssignments.some(assignment =>
            assignment.accounts.some(account => account.HostCollectiveId !== importInstance.collective.id),
          )
        ) {
          throw new ValidationFailed('You can only assign accounts from the same host');
        }

        newValues['settings'] = {
          ...importInstance.settings,
          assignments: mapValues(keyBy(loadedAssignments, 'importedAccountId'), assignments =>
            assignments.accounts.map(account => account.id),
          ),
        };
      }

      if (!isEmpty(newValues)) {
        await importInstance.update(newValues);
      }

      return importInstance;
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
      } else if (['CSV', 'MANUAL'].includes(importInstance.type) === false) {
        throw new ValidationFailed('You can only import transactions in CSV or manually created imports');
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
        file = await UploadedFile.uploadGraphQl(await args.file, 'TRANSACTIONS_IMPORT', req.remoteUser);
      }

      // Register rate limit call as soon as the file is uploaded
      rateLimit.registerCall();

      return sequelize.transaction(async transaction => {
        if (file || args.csvConfig) {
          await importInstance.update(
            {
              UploadedFileId: file?.id,
              settings: { ...importInstance.settings, csvConfig: args.csvConfig },
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
    type: new GraphQLNonNull(
      new GraphQLObjectType({
        name: 'TransactionsImportEditResponse',
        fields: {
          import: {
            type: new GraphQLNonNull(GraphQLTransactionsImport),
            description: 'Updated import',
          },
          rows: {
            type: new GraphQLNonNull(new GraphQLList(GraphQLTransactionsImportRow)),
            description: 'The rows updated by the mutation',
          },
        },
      }),
    ),
    description: 'Update transactions import rows to set new values or perform actions on them',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'ID of the import to add transactions to',
      },
      rows: {
        type: new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImportRowUpdateInput)),
        description: 'Rows to update',
      },
      action: {
        type: new GraphQLNonNull(GraphQLTransactionsImportRowAction),
        description: 'Action to perform on all non-processed rows',
      },
    },
    resolve: async (
      _: void,
      args: {
        id: string;
        rows?: TransactionImportRowGraphQLType[];
        action: (typeof TransactionsImportRowActionTypes)[number];
      },
      req: Request,
    ) => {
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

      const allRowsIds = args.rows?.map(row => idDecode(row.id, 'transactions-import-row')) || [];
      const updatedImport = await sequelize.transaction(async transaction => {
        // Update rows
        if (args.action === 'UPDATE_ROWS') {
          if (!allRowsIds.length) {
            throw new ValidationFailed('You must provide at least one row to update');
          }

          await Promise.all(
            args.rows.map(async (row, index) => {
              const rowId = allRowsIds[index];
              const where = { id: rowId, TransactionsImportId: importId };
              let values: Parameters<typeof TransactionsImportRow.update>[0] = pick(row, [
                'sourceId',
                'description',
                'date',
                'note',
              ]);
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
                values['status'] = 'LINKED';
              } else if (row.expense) {
                const expense = await fetchExpenseWithReference(row.expense, {
                  loaders: req.loaders,
                  throwIfMissing: true,
                });
                const collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
                if (collective.HostCollectiveId !== transactionsImport.CollectiveId) {
                  throw new Unauthorized(`Expense not associated with the import: ${expense.id}`);
                }

                values['ExpenseId'] = expense.id;
                values['status'] = 'LINKED';
              } else if (row.status) {
                values['status'] = row.status;
                where['status'] = { [Op.not]: 'LINKED' }; // Cannot change the status of a LINKED row
              }

              // For plaid imports, users can't change imported data
              if (transactionsImport.type === 'PLAID') {
                values = omit(values, ['amount', 'date', 'sourceId', 'description']);
              }

              const [updatedCount] = await TransactionsImportRow.update(values, { where, transaction });
              if (!updatedCount) {
                throw new NotFound(`Row not found: ${row.id}`);
              }
            }),
          );
        } else if (args.action === 'DISMISS_ALL') {
          await TransactionsImportRow.update(
            { status: 'IGNORED' },
            {
              transaction,
              where: {
                TransactionsImportId: importId,
                status: { [Op.not]: ['LINKED', 'ON_HOLD'] },
                ExpenseId: null,
                OrderId: null,
                ...(allRowsIds.length ? { id: { [Op.in]: allRowsIds } } : {}),
              },
            },
          );
        } else if (args.action === 'RESTORE_ALL') {
          await TransactionsImportRow.update(
            { status: 'PENDING' },
            {
              transaction,
              where: {
                TransactionsImportId: importId,
                status: 'IGNORED',
                ...(allRowsIds.length ? { id: { [Op.in]: allRowsIds } } : {}),
              },
            },
          );
        } else if (args.action === 'PUT_ON_HOLD_ALL') {
          await TransactionsImportRow.update(
            { status: 'ON_HOLD' },
            {
              transaction,
              where: {
                TransactionsImportId: importId,
                status: { [Op.not]: ['LINKED', 'ON_HOLD'] },
                ...(allRowsIds.length ? { id: { [Op.in]: allRowsIds } } : {}),
              },
            },
          );
        }

        // Update import
        return transactionsImport.update({ updatedAt: new Date() }, { transaction });
      });

      return {
        import: updatedImport,
        rows: await TransactionsImportRow.findAll({
          where: {
            TransactionsImportId: importId,
            ...(allRowsIds.length ? { id: { [Op.in]: allRowsIds } } : {}),
          },
        }),
      };
    },
  },
  deleteTransactionsImport: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Delete an import and all its associated rows',
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLNonEmptyString),
        description: 'ID of the import to delete',
      },
    },
    resolve: async (_: void, args, req: Request) => {
      checkRemoteUserCanUseTransactions(req);
      const importId = idDecode(args.id, 'transactions-import');
      const importInstance = await TransactionsImport.findByPk(importId, { include: [{ association: 'collective' }] });
      if (!importInstance) {
        throw new NotFound('Import not found');
      } else if (!req.remoteUser.isAdminOfCollective(importInstance.collective)) {
        throw new Unauthorized('You need to be an admin of the account to delete an import');
      }

      let connectedAccount;
      if (importInstance.type === 'PLAID' && importInstance.ConnectedAccountId) {
        connectedAccount = await importInstance.getConnectedAccount();
        if (!connectedAccount) {
          throw new Error('Connected account not found');
        }

        await twoFactorAuthLib.enforceForAccount(req, connectedAccount.collective, { alwaysAskForToken: true }); // To match the permissions in deleteConnectedAccount
        await disconnectPlaidAccount(connectedAccount);
      }

      return sequelize.transaction(async transaction => {
        // Delete import
        await importInstance.destroy({ transaction });

        // Delete import rows
        await TransactionsImportRow.destroy({ transaction, where: { TransactionsImportId: importId } });

        // Delete uploaded files
        await UploadedFile.destroy({ transaction, where: { id: importInstance.UploadedFileId } });

        // Delete associated connected accounts
        if (connectedAccount) {
          await connectedAccount.destroy({ transaction });
          await ConnectedAccount.destroy({
            transaction,
            where: { data: { MirrorConnectedAccountId: connectedAccount.id } },
          });
        }

        return true;
      });
    },
  },
};

export default transactionImportsMutations;
