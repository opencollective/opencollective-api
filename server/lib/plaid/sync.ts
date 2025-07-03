import { cloneDeep, set, update } from 'lodash';

import ActivityTypes from '../../constants/activities';
import { Activity, TransactionsImport, TransactionsImportRow } from '../../models';
import ConnectedAccount from '../../models/ConnectedAccount';
import { TransactionsImportLockedError } from '../../models/TransactionsImport';
import logger from '../logger';
import { floatAmountToCents } from '../math';
import { reportErrorToSentry, reportMessageToSentry } from '../sentry';

import { getPlaidClient } from './client';

/**
 * Plaid only sync bank accounts a few times per day. You can use this function to trigger
 * a sync manually. Behind the scenes, Plaid will query the bank, then -if there's something
 * new- update its database and call our webhook to notify us that new transactions are
 * available. The webhook itself will call `syncPlaidAccount` to import the new transactions.
 *
 * See https://plaid.com/docs/transactions/webhooks/#forcing-transactions-refresh
 */
export const requestPlaidAccountSync = async (connectedAccount: ConnectedAccount): Promise<void> => {
  try {
    await getPlaidClient().transactionsRefresh({
      /* eslint-disable camelcase */
      client_id: connectedAccount.clientId,
      access_token: connectedAccount.token,
      /* eslint-enable camelcase */
    });
  } catch (e) {
    reportErrorToSentry(e, { extra: { connectedAccountId: connectedAccount.id } });
    throw new Error(`Failed to request a bank account sync: ${e.message}`);
  }
};

/**
 * Sync transactions for a Plaid connected account
 * @returns Whether the sync was successful
 */
export const syncPlaidAccount = async (
  connectedAccount: ConnectedAccount,
  options: { log?: boolean; full?: boolean; silentFailureIfAlreadySyncing?: boolean } = {},
): Promise<boolean> => {
  // Connected account validations
  if (connectedAccount.service !== 'plaid') {
    throw new Error('Connected account is not a Plaid account');
  }

  // Transactions import validations
  const transactionsImport = await TransactionsImport.findOne({ where: { ConnectedAccountId: connectedAccount.id } });
  if (!transactionsImport) {
    throw new Error('Transactions import not found');
  } else if (transactionsImport.type !== 'PLAID') {
    throw new Error('Transactions import is not a Plaid import'); // Defensive programming: This is not supposed to happen, but we do some data integrity checks just in case
  } else if (transactionsImport.CollectiveId !== connectedAccount.CollectiveId) {
    throw new Error('Transactions import does not belong to the connected account'); // Defensive programming: This is not supposed to happen, but we do some data integrity checks just in case
  }

  // Lock the transactions import while syncing to prevent concurrent syncs
  try {
    await transactionsImport.lock(() => syncTransactionsImport(connectedAccount, transactionsImport, options));
  } catch (e) {
    if (options.silentFailureIfAlreadySyncing && e instanceof TransactionsImportLockedError) {
      return false;
    } else {
      throw e;
    }
  }

  return true;
};

const syncTransactionsImport = async (
  connectedAccount: ConnectedAccount,
  transactionsImport: TransactionsImport,
  options: { log?: boolean; full?: boolean } = {},
): Promise<void> => {
  // Get all source IDs that have already been synced
  let syncedTransactionIds = await transactionsImport.getAllSourceIds();

  // Iterate through each page of new transaction updates for item
  let cursor = options.full ? undefined : transactionsImport.data?.plaid?.lastSyncCursor;
  let hasMore = true;
  let isRetryingAfterAnInsertConflict = false;

  if (options.log) {
    logger.info(
      `Syncing transactions for connected account ${connectedAccount.id} from ${cursor || 'start'} and with ${syncedTransactionIds.size} already synced`,
    );
  }

  try {
    while (hasMore) {
      // See https://plaid.com/docs/api/products/transactions/#transactionssync
      const response = await getPlaidClient().transactionsSync({
        /* eslint-disable camelcase */
        client_id: connectedAccount.clientId,
        access_token: connectedAccount.token,
        cursor: cursor,
        count: 500, // Maximum number allowed by Plaid
        /* eslint-enable camelcase */
      });

      const data = response.data;

      // Removed transactions
      if (data.removed.length) {
        const existingTransactionsRemoved = await TransactionsImportRow.findAll({
          where: { TransactionsImportId: transactionsImport.id, sourceId: data.removed.map(tr => tr.transaction_id) },
        });

        // Plaid often send events for "removed" transactions that are in fact transactions going from pending to non-pending.
        // Since we're not recording pending transactions, we can safely ignore these events.
        // See https://github.com/opencollective/opencollective/issues/7617
        if (existingTransactionsRemoved.length) {
          // TODO: Here, we likely want to delete the transactions from the import if it hasn't been
          // reconciled yet, but we need to be careful with the UX.
          reportMessageToSentry('Plaid returned removed transactions for synchronized items', {
            extra: { connectedAccountId: connectedAccount.id, removed: data.removed },
          });
        }
      }

      // Modified transactions
      const nonPendingModifiedTransactions = data.modified.filter(transaction => !transaction.pending); // We're not syncing pending transactions for now, see https://github.com/opencollective/opencollective/issues/7617
      if (nonPendingModifiedTransactions.length) {
        const allSourceIds = nonPendingModifiedTransactions.map(tr => tr.transaction_id);
        const existingRows = await TransactionsImportRow.findAll({
          where: { TransactionsImportId: transactionsImport.id, sourceId: allSourceIds },
        });

        if (existingRows.length !== allSourceIds.length) {
          reportMessageToSentry('Plaid returned modified transactions for items that have not been synchronized', {
            extra: {
              connectedAccountId: connectedAccount.id,
              modified: data.modified,
              existingRowsIds: existingRows.map(r => r.sourceId),
            },
          });
        }

        for (const row of existingRows) {
          const transaction = nonPendingModifiedTransactions.find(tr => tr.transaction_id === row.sourceId);
          const previousData = row.rawValue;
          await row.update({
            description: transaction.name,
            date: new Date(transaction.date),
            amount: -floatAmountToCents(transaction.amount),
            currency: transaction.iso_currency_code,
            rawValue: transaction as unknown as Record<string, unknown>,
            accountId: transaction.account_id,
          });

          await Activity.create({
            HostCollectiveId: connectedAccount.CollectiveId,
            CollectiveId: transactionsImport.CollectiveId,
            ExpenseId: row.ExpenseId,
            OrderId: row.OrderId,
            type: ActivityTypes.TRANSACTIONS_IMPORT_ROW_UPDATED,
            data: { source: 'PLAID', previousData, newData: transaction },
          });
        }
      }

      const newTransactions = data.added.filter(transaction => !syncedTransactionIds.has(transaction.transaction_id));
      if (options.log) {
        logger.info(
          `Fetched ${data.added.length} new transactions, ${data.added.length - newTransactions.length} already synced`,
        );
      }

      // We're not syncing pending transactions for now, see https://github.com/opencollective/opencollective/issues/7617
      const transactionsToAdd = newTransactions.filter(transaction => !transaction.pending);
      if (transactionsToAdd.length) {
        try {
          await transactionsImport.addRows(
            transactionsToAdd.map(plaidTransaction => ({
              sourceId: plaidTransaction.transaction_id,
              isUnique: true, // This enables the unique index on the sourceId column
              description: plaidTransaction.name,
              date: new Date(plaidTransaction.date),
              amount: -floatAmountToCents(plaidTransaction.amount),
              currency: plaidTransaction.iso_currency_code,
              rawValue: plaidTransaction,
              accountId: plaidTransaction.account_id,
            })),
          );
        } catch (e) {
          // This is not supposed to happen because the `syncTransactions` function now has
          // a MUTEX and Plaid webhooks are just notifications that a synchronization should
          // happen (they don't actually insert the transactions). But it still provides
          // an extra layer of protection in case another process tries to insert the same
          // transaction at the same time, so it doesn't hurt to keep it.
          if (!isRetryingAfterAnInsertConflict && e.name === 'SequelizeUniqueConstraintError') {
            if (options.log) {
              logger.warn('One of the transactions already exists in the database, retrying');
            }
            syncedTransactionIds = await transactionsImport.getAllSourceIds();
            isRetryingAfterAnInsertConflict = true;
            continue;
          } else {
            throw e;
          }
        }
      }

      // Update cursor to the next cursor
      isRetryingAfterAnInsertConflict = false;
      cursor = data.next_cursor;
      hasMore = data.has_more;
    }

    if (options.log) {
      logger.info(`Finished syncing transactions for connected account ${connectedAccount.id}`);
    }

    // Record the run in the transaction import
    const newImportData = cloneDeep(transactionsImport.data) || {};
    set(newImportData, 'plaid.lastSyncCursor', cursor);
    set(newImportData, 'plaid.syncAttempt', 0);
    await transactionsImport.update({ lastSyncAt: new Date(), data: newImportData });
  } catch (e) {
    // Record the error + sync attempt in the transaction import
    const newImportData = cloneDeep(transactionsImport.data) || {};
    update(newImportData, 'plaid.syncAttempt', syncAttempt => (syncAttempt || 0) + 1);
    set(newImportData, 'plaid.lastSyncErrorMessage', e.message);
    await transactionsImport.update({ data: newImportData });
    throw e;
  }
};
