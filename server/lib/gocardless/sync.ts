import { isNil, omitBy, trim, truncate, uniq } from 'lodash';
import moment from 'moment';
import NordigenClient from 'nordigen-node';

import { Service } from '../../constants/connected-account';
import { ConnectedAccount, TransactionsImport } from '../../models';
import { floatAmountToCents } from '../currency';
import logger from '../logger';
import { sleep } from '../utils';

import { getGoCardlessClient, getOrRefreshGoCardlessToken } from './client';
import { AccountTransactions } from './types';

export type BookedTransaction = AccountTransactions['transactions']['booked'][number];

/**
 * See https://developer.gocardless.com/bank-account-data/transactions + https://docs.google.com/spreadsheets/d/1ogpzydzotOltbssrc3IQ8rhBLlIZbQgm5QCiiNJrkyA/edit?gid=0#gid=0.
 */
export const getDescriptionForTransaction = (
  transaction: BookedTransaction,
  /** The institution ID, since */
  institutionId: string | undefined,
) => {
  const getBaseDescription = () => {
    // Override for some banks, usually based on user feedback
    if (institutionId === 'COOPERATIVE_CPBKGB22') {
      // Sample
      // "remittanceInformationUnstructured": "Faster Payment",
      // "remittanceInformationUnstructuredArray": [
      //   "AddInfo: 000000",
      //   "CustRef: John Doe",
      //   "BankRef: Something" -- Sometimes equals to AddrInfo
      // ]
      const getValueFromUnstructured = prefix =>
        transaction.remittanceInformationUnstructuredArray
          ?.find(item => item.startsWith(prefix))
          ?.split(`${prefix}: `)[1];

      const base = transaction.remittanceInformationUnstructured;
      const customerRef = getValueFromUnstructured('CustRef');
      const bankRef = getValueFromUnstructured('BankRef');
      const addInfo = getValueFromUnstructured('AddInfo');

      // Format as "Faster Payment: John Doe - Something (000000)"
      const bankRefStr =
        !bankRef && addInfo ? addInfo : !addInfo ? bankRef : bankRef === addInfo ? bankRef : `${bankRef} (${addInfo})`;
      const rest = uniq([customerRef, bankRefStr].filter(Boolean));
      return base && rest.length ? `${base}: ${rest.join(' - ')}` : base || rest.join(' - ');
    }

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

  return getBaseDescription()?.replace(/\s\s+/g, ' ')?.trim() || '';
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
    /** Last successful sync date for this account. Used to compute `dateFrom` when not provided. */
    lastSyncAt?: Date | null;
  },
) => {
  let retryCount = 0;
  let lastError: Error | null = null;

  const dateTo = options.full ? undefined : options.dateTo;
  let dateFrom = options.full ? undefined : options.dateFrom;
  if (!dateFrom && options.lastSyncAt && !options.full) {
    dateFrom = moment(options.lastSyncAt).subtract(1, 'day').toDate();
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
          description: formatDescription(
            getDescriptionForTransaction(transaction, transactionsImport.data?.gocardless?.institution?.id),
          ),
          date: new Date(transaction.bookingDate),
          amount: floatAmountToCents(parseFloat(transaction.transactionAmount.amount)),
          currency: transaction.transactionAmount.currency,
          rawValue: transaction,
          accountId: account,
        })),
      );

      return;
    } catch (e) {
      // This is not supposed to happen, but this check provides
      // an extra layer of protection in case another process tries to insert the same
      // transaction at the same time.
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

/** Fallback delay when GoCardless returns a 429 without telling us when the limit resets */
const DEFAULT_RATE_LIMIT_DELAY_SECONDS = 6 * 60 * 60;

/**
 * Thrown when no account could be synced because they are all rate limited by GoCardless.
 */
export class GoCardlessRateLimitError extends Error {
  retryAt: Date;
  constructor(retryAt: Date) {
    super(
      `The bank data provider only allows a few syncs per day for each bank account. Please try again after ${retryAt.toISOString()}.`,
    );
    this.name = 'GoCardlessRateLimitError';
    this.retryAt = retryAt;
  }
}

export const isGoCardlessRateLimitError = (error: unknown): boolean =>
  (error as { response?: { status?: number } })?.response?.status === 429;

/**
 * Returns the number of seconds to wait before the rate limit resets, based on the 429 response.
 * GoCardless returns an `http_x_ratelimit_account_success_reset` header (seconds), and a
 * `detail` like "... Please try again in 2531 seconds".
 */
export const getRateLimitResetSeconds = (error: unknown): number => {
  const response = (error as { response?: { headers?: Record<string, unknown>; data?: { detail?: unknown } } })
    ?.response;
  const headers = response?.headers || {};
  const getHeader = (name: string) => {
    const value =
      typeof (headers as { get?: unknown }).get === 'function'
        ? (headers as { get: (n: string) => unknown }).get(name)
        : headers[name];
    const parsed = parseInt(value as string, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const fromHeader =
    getHeader('http_x_ratelimit_account_success_reset') ||
    getHeader('x-ratelimit-account-success-reset') ||
    getHeader('http_x_ratelimit_reset') ||
    getHeader('x-ratelimit-reset');
  if (fromHeader) {
    return fromHeader;
  }

  const detail = response?.data?.detail;
  if (typeof detail === 'string') {
    const match = detail.match(/(\d+)\s*seconds?/i);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return DEFAULT_RATE_LIMIT_DELAY_SECONDS;
};

type AccountSyncState = NonNullable<TransactionsImport['data']['gocardless']['accountsSyncState']>[string];

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

  const getAccountState = (account: string): AccountSyncState =>
    transactionsImport.data?.gocardless?.accountsSyncState?.[account] || {};

  // Skip accounts that are rate limited (before making any API call)
  const now = new Date();
  const accountsToSync = filteredAccounts.filter(account => {
    const { rateLimitedUntil } = getAccountState(account);
    return !rateLimitedUntil || new Date(rateLimitedUntil) <= now;
  });

  if (!accountsToSync.length) {
    throw new GoCardlessRateLimitError(getEarliestRetryDate(filteredAccounts, getAccountState));
  }

  const client = getGoCardlessClient();
  await getOrRefreshGoCardlessToken(client);
  await transactionsImport.lock(async () => {
    const errors: Error[] = [];
    let hasSyncedAnyAccount = false;

    // Accounts are synced independently: a failure on one of them must not prevent the others from syncing
    for (const account of accountsToSync) {
      const previousState = getAccountState(account);
      const lastSyncAt = previousState.lastSyncAt ? new Date(previousState.lastSyncAt) : transactionsImport.lastSyncAt;
      let newState: AccountSyncState;
      try {
        await syncIndividualAccount(client, account, transactionsImport, { ...options, lastSyncAt });
        newState = { lastSyncAt: new Date().toISOString() };
        hasSyncedAnyAccount = true;
      } catch (e) {
        if (isGoCardlessRateLimitError(e)) {
          const rateLimitedUntil = moment().add(getRateLimitResetSeconds(e), 'seconds').toDate();
          logger.info(`GoCardless account ${account} is rate limited until ${rateLimitedUntil.toISOString()}`);
          newState = {
            ...previousState,
            rateLimitedUntil: rateLimitedUntil.toISOString(),
            lastErrorMessage: undefined,
          };
        } else {
          errors.push(e);
          newState = {
            ...previousState,
            rateLimitedUntil: undefined,
            lastErrorMessage: truncate(e.message, { length: 255 }),
          };
        }
      }

      await saveAccountSyncState(transactionsImport, account, newState);
    }

    if (hasSyncedAnyAccount) {
      await transactionsImport.update({ lastSyncAt: new Date() });
    }

    if (errors.length) {
      throw errors[0];
    } else if (!hasSyncedAnyAccount) {
      throw new GoCardlessRateLimitError(getEarliestRetryDate(filteredAccounts, getAccountState));
    }
  });
};

const getEarliestRetryDate = (accounts: string[], getAccountState: (account: string) => AccountSyncState): Date => {
  const dates = accounts
    .map(account => getAccountState(account).rateLimitedUntil)
    .filter(Boolean)
    .map(date => new Date(date));
  return dates.length ? new Date(Math.min(...dates.map(date => date.getTime()))) : new Date();
};

const saveAccountSyncState = async (
  transactionsImport: TransactionsImport,
  account: string,
  state: AccountSyncState,
) => {
  if (!transactionsImport.data?.gocardless) {
    return; // Should never happen for GoCardless imports, but the schema requires the `gocardless` object to be complete
  }

  await transactionsImport.update({
    data: {
      ...transactionsImport.data,
      gocardless: {
        ...transactionsImport.data.gocardless,
        accountsSyncState: {
          ...transactionsImport.data.gocardless.accountsSyncState,
          [account]: omitBy(state, isNil) as AccountSyncState,
        },
      },
    },
  });
};
