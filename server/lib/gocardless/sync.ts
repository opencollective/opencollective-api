import { trim, truncate } from 'lodash';
import moment from 'moment';
import NordigenClient from 'nordigen-node';

import { Service } from '../../constants/connected-account';
import { ConnectedAccount, TransactionsImport } from '../../models';
import logger from '../logger';
import { floatAmountToCents } from '../math';
import { sleep } from '../utils';

import { getGoCardlessClient, getOrRefreshGoCardlessToken } from './client';
import { AccountTransactions } from './types';

/**
 * See https://developer.gocardless.com/bank-account-data/transactions + https://docs.google.com/spreadsheets/d/1ogpzydzotOltbssrc3IQ8rhBLlIZbQgm5QCiiNJrkyA/edit?gid=0#gid=0.
 */
const getDescriptionForTransaction = (transaction: AccountTransactions['transactions']['booked'][number]) => {
  // Generally (but not always) available
  if (transaction.remittanceInformationStructured) {
    return transaction.remittanceInformationStructured;
  } else if (transaction.remittanceInformationUnstructured) {
    return transaction.remittanceInformationUnstructured;
  } else if (transaction.remittanceInformationStructuredArray?.length) {
    return transaction.remittanceInformationStructuredArray.join(', ');
  } else if (transaction.remittanceInformationUnstructuredArray?.length) {
    return transaction.remittanceInformationUnstructuredArray.join(', ');
  }

  // Fallback: generate a generic description
  const amount = parseFloat(transaction.transactionAmount.amount);
  const description = [];
  if (amount > 0) {
    description.push('Credit');
    if (transaction.creditorName) {
      description.push(`to ${transaction.creditorName}`);
    }
  } else {
    description.push('Debit');
    if (transaction.debtorName) {
      description.push(`from ${transaction.debtorName}`);
    }
  }

  return description.join(' ');
};

/**
 * "   A   description very long" -> "A description very..."
 */
const formatDescription = (description: string) => {
  return truncate(trim(description.replace(/\s+/g, ' ')), { length: 255 });
};

const syncIndividualAccount = async (
  client: NordigenClient,
  account: string,
  transactionsImport: TransactionsImport,
  options: {
    dateFrom?: Date;
    dateTo?: Date;
    full?: boolean;
    log?: boolean;
    retryFor?: number;
  },
) => {
  let retryCount = 0;
  let lastError: Error | null = null;

  const dateTo = options.full ? undefined : options.dateTo;
  let dateFrom = options.full ? undefined : options.dateFrom;
  if (!dateFrom && transactionsImport.lastSyncAt && !options.full) {
    dateFrom = moment(transactionsImport.lastSyncAt).subtract(1, 'day').toDate();
  }

  if (options.log) {
    const logParts = [`Syncing GoCardless account ${account}`];
    if (dateFrom) {
      logParts.push(`from ${dateFrom.toISOString().split('T')[0]}`);
    }
    if (dateTo) {
      logParts.push(`to ${dateTo.toISOString().split('T')[0]}`);
    }
    logger.info(logParts.join(' '));
  }

  while (retryCount <= 1) {
    const syncedTransactionIds = await transactionsImport.getAllSourceIds();

    let timeSpent = 0;
    let transactions: AccountTransactions;
    while (!transactions && (!options.retryFor || timeSpent < options.retryFor)) {
      try {
        // @ts-expect-error Invalid type in nordigen-node: country is not a valid parameter
        transactions = await client.account(account).getTransactions({
          dateFrom: !dateFrom ? undefined : dateFrom.toISOString().split('T')[0],
          dateTo: !dateTo ? undefined : dateTo.toISOString().split('T')[0],
        });

        break;
      } catch (e) {
        if (e.response?.status === 409 && options.retryFor) {
          await sleep(1000);
          timeSpent += 1000;
        } else {
          throw e;
        }
      }
    }

    if (!transactions) {
      throw new Error('Failed to sync transactions');
    }

    const newTransactions = transactions.transactions.booked.filter(
      transaction => !syncedTransactionIds.has(transaction.internalTransactionId),
    );

    if (options.log) {
      logger.info(
        `Found ${transactions.transactions.booked.length} transactions for account ${account} (${newTransactions.length} new)`,
      );
    }

    if (!newTransactions.length) {
      return;
    }

    try {
      await transactionsImport.addRows(
        newTransactions.map(transaction => ({
          sourceId: transaction.internalTransactionId,
          isUnique: true,
          description: formatDescription(getDescriptionForTransaction(transaction)),
          date: new Date(transaction.bookingDate),
          amount: floatAmountToCents(parseFloat(transaction.transactionAmount.amount)),
          currency: transaction.transactionAmount.currency,
          rawValue: transaction,
          accountId: account,
        })),
      );
    } catch (e) {
      // This is not supposed to happen because the `syncTransactions` function now has
      // a MUTEX and Plaid webhooks are just notifications that a synchronization should
      // happen (they don't actually insert the transactions). But it still provides
      // an extra layer of protection in case another process tries to insert the same
      // transaction at the same time, so it doesn't hurt to keep it.
      if (e.name === 'SequelizeUniqueConstraintError') {
        ++retryCount;
        lastError = e;
        continue;
      } else {
        throw e;
      }
    }
  }

  throw new Error('Failed to sync transactions due to duplicate source IDs', { cause: lastError });
};

/**
 * Sync transactions for a GoCardless connected account.
 */
export const syncGoCardlessAccount = async (
  connectedAccount: ConnectedAccount,
  transactionsImport: TransactionsImport,
  options: {
    /** Start date for transaction sync (YYYY-MM-DD). Defaults to the last sync date minus 1 day. */
    dateFrom?: Date;
    /** End date for transaction sync (YYYY-MM-DD). Defaults to now. */
    dateTo?: Date;
    /** Whether to ignore lastSyncAt and sync all transactions. */
    full?: boolean;
    /** List of account IDs to sync. Defaults to all accounts. */
    accounts?: string[];
    log?: boolean;
    /** Retry for this amount of time if the sync fails because of a 409 ("Your account data is currently being processed") */
    retryFor?: number;
  } = {},
) => {
  if (connectedAccount.service !== Service.GOCARDLESS) {
    throw new Error('Connected account is not a GoCardless account');
  }

  const allAccounts = options.accounts || connectedAccount.data.gocardless.requisition.accounts;
  const filteredAccounts = options.accounts
    ? allAccounts.filter(account => options.accounts?.includes(account))
    : allAccounts;

  if (!filteredAccounts?.length) {
    throw new Error('No accounts to sync');
  }

  const client = getGoCardlessClient();
  await getOrRefreshGoCardlessToken(client);
  await transactionsImport.lock(async () => {
    for (const account of filteredAccounts) {
      await syncIndividualAccount(client, account, transactionsImport, options);
    }

    await transactionsImport.update({
      lastSyncAt: new Date(),
    });
  });
};
