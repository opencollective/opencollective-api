import crypto from 'crypto';

import { find, has, pick } from 'lodash';
import { v4 as uuid } from 'uuid';

import { TransferwiseError } from '../../graphql/errors';
import cache from '../../lib/cache';
import * as transferwise from '../../lib/transferwise';
import models from '../../models';
import { ConnectedAccount } from '../../types/ConnectedAccount';
import { Balance, Quote, RecipientAccount, Transfer } from '../../types/transferwise';

const hashObject = obj => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 7);

export const blockedCurrencies = ['NGN'];
export const blockedCurrenciesForBusinesProfiles = ['BRL', 'PKR'];
export const currenciesThatRequireReference = ['RUB'];

async function populateProfileId(connectedAccount): Promise<void> {
  if (!connectedAccount.data?.id) {
    const profiles = await transferwise.getProfiles(connectedAccount.token);
    const profile =
      profiles.find(p => p.type === connectedAccount.data?.type) ||
      profiles.find(p => p.type === 'business') ||
      profiles[0];
    if (profile) {
      await connectedAccount.update({ data: { ...connectedAccount.data, ...profile } });
    }
  }
}

async function getTemporaryQuote(connectedAccount, payoutMethod, expense): Promise<Quote> {
  return await transferwise.getTemporaryQuote(connectedAccount.token, {
    sourceCurrency: expense.currency,
    targetCurrency: payoutMethod.data.currency,
    sourceAmount: expense.amount / 100,
  });
}

async function quoteExpense(connectedAccount, payoutMethod, expense): Promise<Quote> {
  await populateProfileId(connectedAccount);

  // Guarantees the target amount if in the same currency of expense
  const { rate } = await getTemporaryQuote(connectedAccount, payoutMethod, expense);
  const targetAmount = (expense.amount / 100) * rate;

  const quote = await transferwise.createQuote(connectedAccount.token, {
    profileId: connectedAccount.data.id,
    sourceCurrency: expense.currency,
    targetCurrency: payoutMethod.data.currency,
    targetAmount,
  });

  return quote;
}

async function payExpense(
  connectedAccount,
  payoutMethod,
  expense,
): Promise<{
  quote: Quote;
  recipient: RecipientAccount;
  fund: { status: string; errorCode: string };
  transfer: Transfer;
}> {
  const quote = await quoteExpense(connectedAccount, payoutMethod, expense);

  const account = await transferwise.getBorderlessAccount(connectedAccount.token, connectedAccount.data.id);
  if (!account) {
    throw new TransferwiseError(
      `We can't retrieve your Transferwise borderless account. Please re-connect or contact support at support@opencollective.com.`,
      'transferwise.error.accountnotfound',
    );
  }
  const balance = account.balances.find(b => b.currency === quote.source);
  if (!balance || balance.amount.value < quote.sourceAmount) {
    throw new TransferwiseError(
      `You don't have enough funds in your ${quote.source} balance. Please top up your account considering the source amount of ${quote.sourceAmount} (includes the fee ${quote.fee}) and try again.`,
      'transferwise.error.insufficientFunds',
      { currency: quote.source },
    );
  }

  const recipient = await transferwise.createRecipientAccount(connectedAccount.token, {
    profileId: connectedAccount.data.id,
    ...payoutMethod.data,
  });

  const transferOptions: transferwise.CreateTransfer = {
    accountId: recipient.id,
    quoteId: quote.id,
    uuid: uuid(),
  };
  // Append reference to currencies that require it.
  if (currenciesThatRequireReference.includes(payoutMethod.data.currency)) {
    transferOptions.details = { reference: `${expense.id}` };
  }
  const transfer = await transferwise.createTransfer(connectedAccount.token, transferOptions);

  let fund;
  try {
    fund = await transferwise.fundTransfer(connectedAccount.token, {
      profileId: connectedAccount.data.id,
      transferId: transfer.id,
    });
  } catch (e) {
    await transferwise.cancelTransfer(connectedAccount.token, transfer.id);
    throw e;
  }

  return { quote, recipient, transfer, fund };
}

async function getAvailableCurrencies(
  host: any,
  ignoreBlockedCurrencies = true,
): Promise<{ code: string; minInvoiceAmount: number }[]> {
  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { service: 'transferwise', CollectiveId: host.id },
  });
  if (!connectedAccount) {
    throw new TransferwiseError('Host is not connected to Transferwise', 'transferwise.error.notConnected');
  }

  let currencyBlockList = [];
  if (ignoreBlockedCurrencies) {
    currencyBlockList = blockedCurrencies;
    if (connectedAccount.data?.type === 'business') {
      currencyBlockList = [...currencyBlockList, ...blockedCurrenciesForBusinesProfiles];
    }
  }

  const cacheKey = `transferwise_available_currencies_${host.id}`;
  const fromCache = await cache.get(cacheKey);
  if (fromCache) {
    return fromCache.filter(c => !currencyBlockList.includes(c.code));
  }

  await populateProfileId(connectedAccount);

  const pairs = await transferwise.getCurrencyPairs(connectedAccount.token);
  const source = pairs.sourceCurrencies.find(sc => sc.currencyCode === host.currency);
  const currencies = source.targetCurrencies.map(c => ({ code: c.currencyCode, minInvoiceAmount: c.minInvoiceAmount }));
  cache.set(cacheKey, currencies, 24 * 60 * 60 /* a whole day and we could probably increase */);
  return currencies.filter(c => !currencyBlockList.includes(c.code));
}

async function getRequiredBankInformation(host: any, currency: string, accountDetails?: any): Promise<any> {
  const cacheKey = accountDetails
    ? `transferwise_required_bank_info_${host.id}_${currency}_${hashObject(
        pick(accountDetails, ['type', 'details.bankCode', 'details.legalType', 'details.address.country']),
      )}`
    : `transferwise_required_bank_info_${host.id}_to_${currency}`;
  const fromCache = await cache.get(cacheKey);
  if (fromCache) {
    return fromCache;
  }

  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { service: 'transferwise', CollectiveId: host.id },
  });
  if (!connectedAccount) {
    throw new TransferwiseError('Host is not connected to Transferwise', 'transferwise.error.notConnected');
  }
  await populateProfileId(connectedAccount);

  const currencyInfo = find(await getAvailableCurrencies(host), { code: currency });
  if (!currencyInfo) {
    throw new TransferwiseError('This currency is not supported', 'transferwise.error.currencyNotSupported');
  }

  const transactionParams = {
    sourceCurrency: host.currency,
    targetCurrency: currency,
    sourceAmount: currencyInfo.minInvoiceAmount * 20,
  };

  const requiredFields =
    accountDetails && has(accountDetails, 'details')
      ? await transferwise.validateAccountRequirements(connectedAccount.token, transactionParams, accountDetails)
      : await transferwise.getAccountRequirements(connectedAccount.token, transactionParams);

  cache.set(cacheKey, requiredFields, 24 * 60 * 60 /* a whole day and we could probably increase */);
  return requiredFields;
}

async function getAccountBalances(connectedAccount: ConnectedAccount): Promise<Balance[]> {
  await populateProfileId(connectedAccount);
  const account = await transferwise.getBorderlessAccount(connectedAccount.token, connectedAccount.data.id);
  return account?.balances || [];
}

export default {
  getAvailableCurrencies,
  getRequiredBankInformation,
  getAccountBalances,
  getTemporaryQuote,
  quoteExpense,
  payExpense,
};
