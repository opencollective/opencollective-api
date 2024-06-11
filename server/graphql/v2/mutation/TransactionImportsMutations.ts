import type { Request } from 'express';
import { GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLJSONObject, GraphQLNonEmptyString } from 'graphql-scalars';
import GraphQLUpload from 'graphql-upload/GraphQLUpload.js';
import { isUndefined, omit, omitBy } from 'lodash';

import { sequelize, TransactionsImport, TransactionsImportRow, UploadedFile } from '../../../models';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { NotFound, Unauthorized } from '../../errors';
import { GraphQLTransactionsImportType } from '../enum/TransactionsImportType';
import { idDecode } from '../identifiers';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../input/AmountInput';
import { GraphQLTransactionsImportRowCreateInput } from '../input/TransactionsImportRowCreateInput';
import { GraphQLTransactionsImportRowUpdateInput } from '../input/TransactionsImportRowUpdateInput';
import { GraphQLTransactionsImport } from '../object/TransactionsImport';

const transactionImportsMutations = {
  createTransactionsImport: {
    type: new GraphQLNonNull(GraphQLTransactionsImport),
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
        description: 'Name of the import (e.g. "Contributions May 2021", "Tickets for Mautic COnference 2024")',
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
      if (!importInstance) {
        throw new NotFound(`Import not found: ${args.id}`);
      } else if (!req.remoteUser.isAdminOfCollective(importInstance.collective)) {
        throw new Unauthorized('You need to be an admin of the account to import transactions');
      }

      // Handle CSV
      let file;
      if (args.file) {
        file = await UploadedFile.uploadGraphQl(await args.file, 'TRANSACTIONS_IMPORT', req.remoteUser, {
          supportedMimeTypes: ['text/csv'],
        });
      }

      return sequelize.transaction(async transaction => {
        if (file || args.csvConfig) {
          await importInstance.update({ UploadedFileId: file?.id, csvConfig: args.csvConfig }, { transaction });
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

      return sequelize.transaction(async transaction => {
        // Update rows
        await Promise.all(
          args.rows.map(async row => {
            const rowId = idDecode(row.id, 'transactions-import-row');
            const values = omitBy(omit(row, 'id'), isUndefined);
            if (row.amount) {
              values.amount = getValueInCentsFromAmountInput(row.amount);
              values.currency = row.amount.currency;
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
