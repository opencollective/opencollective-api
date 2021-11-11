import crypto from 'crypto';

import config from 'config';
import express from 'express';
import { compact, difference, find, has, omit, pick, split, toNumber } from 'lodash';
import moment from 'moment';
import { v4 as uuid } from 'uuid';

import activities from '../../constants/activities';
import status from '../../constants/expense_status';
import { TransferwiseError } from '../../graphql/errors';
import cache from '../../lib/cache';
import logger from '../../lib/logger';
import * as transferwise from '../../lib/transferwise';
import models from '../../models';
import PayoutMethod from '../../models/PayoutMethod';
import { ConnectedAccount } from '../../types/ConnectedAccount';
import {
  Balance,
  BatchGroup,
  QuoteV2,
  QuoteV2PaymentOption,
  RecipientAccount,
  Transfer,
} from '../../types/transferwise';

const providerName = 'transferwise';

const hashObject = obj => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 7);
const splitCSV = string => compact(split(string, /,\s*/));

export const blockedCurrencies = splitCSV(config.transferwise.blockedCurrencies);
export const blockedCurrenciesForBusinessProfiles = splitCSV(config.transferwise.blockedCurrenciesForBusinessProfiles);
export const blockedCurrenciesForNonProfits = splitCSV(config.transferwise.blockedCurrenciesForNonProfits);
export const currenciesThatRequireReference = ['RUB'];

async function getToken(connectedAccount: ConnectedAccount): Promise<string> {
  // Old token, does not expires
  // eslint-disable-next-line camelcase
  if (!connectedAccount.data?.expires_in) {
    return connectedAccount.token;
  }
  // OAuth token, require us to refresh every 12 hours
  await connectedAccount.reload();
  const updatedAt = moment(connectedAccount.updatedAt);
  const diff = moment.duration(moment().diff(updatedAt)).asSeconds();
  const isOutdated = diff > <number>connectedAccount.data.expires_in - 60;
  if (isOutdated) {
    const newToken = await transferwise.getOrRefreshToken({ refreshToken: connectedAccount.refreshToken });
    const { access_token: token, refresh_token: refreshToken, ...data } = newToken;
    await connectedAccount.update({ token, refreshToken, data: { ...connectedAccount.data, ...data } });
    return token;
  } else {
    return connectedAccount.token;
  }
}

async function populateProfileId(connectedAccount: typeof models.ConnectedAccount, profileId?: number): Promise<void> {
  if (!connectedAccount.data?.id) {
    const token = await getToken(connectedAccount);
    const profiles = await transferwise.getProfiles(token);
    const profile = profileId
      ? profiles.find(p => p.id === profileId)
      : profiles.find(p => p.type === connectedAccount.data?.type) ||
        profiles.find(p => p.type === 'business') ||
        profiles[0];
    if (profile) {
      await connectedAccount.update({ data: { ...connectedAccount.data, ...profile } });
    }
  }
}

async function getTemporaryQuote(
  connectedAccount: typeof models.ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: typeof models.Expense,
): Promise<QuoteV2> {
  const token = await getToken(connectedAccount);
  return await transferwise.getTemporaryQuote(token, {
    sourceCurrency: expense.currency,
    targetCurrency: <string>payoutMethod.unfilteredData.currency,
    sourceAmount: expense.amount / 100,
  });
}

async function createRecipient(
  connectedAccount: typeof models.ConnectedAccount,
  payoutMethod: PayoutMethod,
): Promise<RecipientAccount & { payoutMethodId: number }> {
  const token = await getToken(connectedAccount);
  const recipient = await transferwise.createRecipientAccount(token, {
    profileId: connectedAccount.data.id,
    ...(<RecipientAccount>payoutMethod.data),
  });

  return { ...recipient, payoutMethodId: payoutMethod.id };
}

async function quoteExpense(
  connectedAccount: typeof models.ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: typeof models.Expense,
  targetAccount?: number,
): Promise<QuoteV2> {
  await populateProfileId(connectedAccount);

  const token = await getToken(connectedAccount);
  // Guarantees the target amount if in the same currency of expense
  const { rate } = await getTemporaryQuote(connectedAccount, payoutMethod, expense);
  const targetAmount = (expense.amount / 100) * rate;

  const quote = await transferwise.createQuote(token, {
    profileId: connectedAccount.data.id,
    sourceCurrency: expense.currency,
    targetCurrency: <string>payoutMethod.unfilteredData.currency,
    targetAmount,
    targetAccount,
  });

  return quote;
}

async function createTransfer(
  connectedAccount: typeof models.ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: typeof models.Expense,
  options?: { token?: string; batchGroupId?: string },
): Promise<{
  quote: QuoteV2;
  recipient: RecipientAccount;
  transfer: Transfer;
  paymentOption: QuoteV2PaymentOption;
}> {
  try {
    const token = options?.token || (await getToken(connectedAccount));
    const profileId = connectedAccount.data.id;

    if (!payoutMethod) {
      payoutMethod = await expense.getPayoutMethod();
    }

    const recipient =
      expense.data?.recipient?.payoutMethodId === payoutMethod.id
        ? expense.data.recipient
        : await createRecipient(connectedAccount, payoutMethod);

    const quote = await quoteExpense(connectedAccount, payoutMethod, expense, recipient.id);
    const paymentOption = quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);
    if (!paymentOption || paymentOption.disabled) {
      const message =
        paymentOption?.disabledReason?.message ||
        `We can't find a compatible wise payment method for this transaction. Please re-connecte Wise or contact support at support@opencollective.com`;
      throw new TransferwiseError(message, null, { quote });
    }

    const account = await transferwise.getBorderlessAccount(token, <number>profileId);
    if (!account) {
      throw new TransferwiseError(
        `We can't retrieve your Transferwise borderless account. Please re-connect or contact support at support@opencollective.com.`,
        'transferwise.error.accountnotfound',
      );
    }
    const balance = account.balances.find(b => b.currency === quote.sourceCurrency);
    if (!balance || balance.amount.value < quote.sourceAmount) {
      throw new TransferwiseError(
        `You don't have enough funds in your ${quote.sourceCurrency} balance. Please top up your account considering the source amount of ${quote.sourceAmount} (includes the fee ${paymentOption.fee.total}) and try again.`,
        'transferwise.error.insufficientFunds',
        { currency: quote.sourceCurrency },
      );
    }

    const transferOptions: transferwise.CreateTransfer = {
      accountId: recipient.id,
      quoteUuid: quote.id,
      customerTransactionId: uuid(),
    };
    // Append reference to currencies that require it.
    if (
      currenciesThatRequireReference.includes(<string>payoutMethod.unfilteredData.currency) ||
      options?.batchGroupId
    ) {
      transferOptions.details = { reference: `${expense.id}` };
    }

    const transfer = options?.batchGroupId
      ? await transferwise.createBatchGroupTransfer(token, profileId, options.batchGroupId, transferOptions)
      : await transferwise.createTransfer(token, transferOptions);

    await expense.update({
      data: { ...expense.data, quote: omit(quote, ['paymentOptions']), recipient, transfer, paymentOption },
    });

    return { quote, recipient, transfer, paymentOption };
  } catch (e) {
    logger.error(`Wise: Error creating transaction for expense: ${expense.id}`, e);
    await expense.update({ status: status.ERROR });
    const user = await models.User.findByPk(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, user, { error: { message: e.message } });
    throw e;
  }
}

async function payExpense(
  connectedAccount: typeof models.ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: typeof models.Expense,
  batchGroupId?: string,
): Promise<{
  quote: QuoteV2;
  recipient: RecipientAccount;
  fund: { status: string; errorCode: string };
  transfer: Transfer;
  paymentOption: QuoteV2PaymentOption;
}> {
  const token = await getToken(connectedAccount);
  const profileId = connectedAccount.data.id;

  const { quote, recipient, transfer, paymentOption } = await createTransfer(connectedAccount, payoutMethod, expense, {
    batchGroupId,
    token,
  });

  let fund;
  try {
    fund = await transferwise.fundTransfer(token, {
      profileId,
      transferId: transfer.id,
    });
  } catch (e) {
    logger.error(`Wise: Error paying expense ${expense.id}`, e);
    await transferwise.cancelTransfer(token, transfer.id);
    throw e;
  }

  return { quote, recipient, transfer, fund, paymentOption };
}

const getOrCreateActiveBatch = async (
  host: typeof models.Collective,
  options?: { connectedAccount?: string; token?: string },
): Promise<BatchGroup> => {
  const expense = await models.Expense.findOne({
    where: { status: status.SCHEDULED_FOR_PAYMENT, data: { batchGroup: { status: 'NEW' } } },
    order: [['updatedAt', 'DESC']],
    include: [
      { model: models.PayoutMethod, as: 'PayoutMethod', required: true },
      {
        model: models.Collective,
        as: 'collective',
        where: { HostCollectiveId: host.id },
        required: true,
      },
    ],
  });

  if (expense) {
    return expense.data.batchGroup as BatchGroup;
  } else {
    const connectedAccount = await host.getAccountForPaymentProvider(providerName);

    const profileId = connectedAccount.data.id;
    const token = options?.token || (await getToken(connectedAccount));
    const batchGroup = await transferwise.createBatchGroup(token, profileId, {
      name: uuid(),
      sourceCurrency: connectedAccount.data.currency || host.currency,
    });

    return batchGroup;
  }
};

async function scheduleExpenseForPayment(expense: typeof models.Expense): Promise<typeof models.Expense> {
  const collective = await expense.getCollective();
  const host = await collective.getHostCollective();
  if (!host) {
    throw new Error(`Can not find Host for expense ${expense.id}`);
  }

  if (expense.currency !== host.currency) {
    throw new Error('Can not batch an expense with a currency different from its host currency');
  }

  const connectedAccount = await host.getAccountForPaymentProvider(providerName);
  const token = await getToken(connectedAccount);

  // Check for any existing Batch Group where status = NEW, create a new one if needed
  const batchGroup = await getOrCreateActiveBatch(host, { connectedAccount, token });
  await createTransfer(connectedAccount, expense.PayoutMethod, expense, {
    batchGroupId: batchGroup.id,
    token,
  });
  await expense.reload();
  await expense.update({ data: { ...expense.data, batchGroup } });
  return expense;
}

async function unscheduleExpenseForPayment(expense: typeof models.Expense): Promise<typeof models.Expense> {
  if (!expense.data.batchGroup) {
    throw new Error(`Expense does not belong to any batch group`);
  }

  const collective = await expense.getCollective();
  const host = await collective.getHostCollective();
  if (!host) {
    throw new Error(`Can not find Host for expense ${expense.id}`);
  }

  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

  const profileId = connectedAccount.data.id;
  const token = await getToken(connectedAccount);

  const batchGroup = await transferwise.getBatchGroup(token, profileId, expense.data.batchGroup.id);
  const expensesInBatch = await models.Expense.findAll({
    where: { data: { batchGroup: { id: batchGroup.id } } },
  });

  logger.warn(`Wise: canceling batchGroup ${batchGroup.id} with ${expensesInBatch.length} for host ${host.slug}`);
  await transferwise.cancelBatchGroup(token, profileId, batchGroup.id, batchGroup.version);
  await Promise.all(
    expensesInBatch.map(expense => {
      return expense.update({
        data: omit(expense.data, ['batchGroup', 'quote', 'transfer', 'paymentOption']),
        status: status.APPROVED,
      });
    }),
  );
}

async function payExpensesBatchGroup(host, expenses, x2faApproval?: string) {
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

  const profileId = connectedAccount.data.id;
  const token = await getToken(connectedAccount);

  try {
    if (!x2faApproval && expenses) {
      let batchGroup = await transferwise.getBatchGroup(token, profileId, expenses[0].data.batchGroup.id);
      if (batchGroup.status !== 'NEW') {
        throw new Error('Can not pay batch group, status !== NEW');
      }
      const expenseTransferIds = expenses.map(e => e.data.transfer.id);
      if (difference(batchGroup.transferIds, expenseTransferIds).length > 0) {
        throw new Error(`Expenses requested do not match the transfers added to batch group ${batchGroup.id}`);
      }
      expenses.forEach(expense => {
        if (expense.data.batchGroup.id !== batchGroup.id) {
          throw new Error(
            `All expenses should belong to the same batch group. Unschedule expense ${expense.id} and try again`,
          );
        }
        if (moment().isSameOrAfter(expense.data.quote.expirationTime)) {
          throw new Error(`Expense ${expense.id} quote expired. Unschedule expense and try again`);
        }
        if (!batchGroup.transferIds.includes(expense.data.transfer.id)) {
          throw new Error(`Batch group ${batchGroup.id} does not include expense ${expense.id}`);
        }
      });

      batchGroup = await transferwise.completeBatchGroup(token, profileId, batchGroup.id, batchGroup.version);
      const fundResponse = await transferwise.fundBatchGroup(token, profileId, batchGroup.id);
      if ('status' in fundResponse && 'headers' in fundResponse) {
        const cacheKey = `transferwise_ott_${fundResponse.headers['x-2fa-approval']}`;
        await cache.set(cacheKey, batchGroup.id, 30 * 60);
      }
      return fundResponse;
    } else if (x2faApproval) {
      const cacheKey = `transferwise_ott_${x2faApproval}`;
      const batchGroupId = await cache.get(cacheKey);
      return await transferwise.fundBatchGroup(token, profileId, batchGroupId, x2faApproval);
    } else {
      throw new Error('payExpensesBatchGroup: you need to pass either expenses or x2faApproval');
    }
  } catch (e) {
    logger.error('Error paying Wise batch group', e);
    throw e;
  }
}

async function getAvailableCurrencies(
  host: typeof models.Collective,
  ignoreBlockedCurrencies = true,
): Promise<{ code: string; minInvoiceAmount: number }[]> {
  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

  let currencyBlockList = [];
  if (ignoreBlockedCurrencies) {
    currencyBlockList = blockedCurrencies;
    if (connectedAccount.data?.type === 'business') {
      currencyBlockList = [...currencyBlockList, ...blockedCurrenciesForBusinessProfiles];
    }
    if (connectedAccount.data?.details?.companyType === 'NON_PROFIT_CORPORATION') {
      currencyBlockList = [...currencyBlockList, ...blockedCurrenciesForNonProfits];
    }
    if (connectedAccount.data?.blockedCurrencies) {
      currencyBlockList = [...currencyBlockList, ...connectedAccount.data.blockedCurrencies];
    }
  }

  const cacheKey = `transferwise_available_currencies_${host.id}`;
  const fromCache = await cache.get(cacheKey);
  if (fromCache) {
    return fromCache.filter(c => !currencyBlockList.includes(c.code));
  }

  const token = await getToken(connectedAccount);
  await populateProfileId(connectedAccount);

  const pairs = await transferwise.getCurrencyPairs(token);
  const source = pairs.sourceCurrencies.find(sc => sc.currencyCode === host.currency);
  const currencies = source.targetCurrencies.map(c => ({ code: c.currencyCode, minInvoiceAmount: c.minInvoiceAmount }));
  cache.set(cacheKey, currencies, 24 * 60 * 60 /* a whole day and we could probably increase */);
  return currencies.filter(c => !currencyBlockList.includes(c.code));
}

function validatePayoutMethod(connectedAccount: typeof models.ConnectedAccount, payoutMethod: PayoutMethod): void {
  const currency = (<RecipientAccount>payoutMethod.data)?.currency;
  if (connectedAccount.data?.type === 'business' && blockedCurrenciesForBusinessProfiles.includes(currency)) {
    throw new Error(`Sorry, this host's business profile can not create a transaction to ${currency}`);
  }
  if (
    connectedAccount.data?.details?.companyType === 'NON_PROFIT_CORPORATION' &&
    blockedCurrenciesForNonProfits.includes(currency)
  ) {
    throw new Error(`Sorry, this host's non profit corporation can not create a transaction to ${currency}`);
  }
  if (connectedAccount.data?.blockedCurrencies?.includes(currency)) {
    throw new Error(`Sorry, this host's account can not create a transaction to ${currency}`);
  }
}

async function getRequiredBankInformation(
  host: typeof models.Collective,
  currency: string,
  accountDetails?: Record<string, unknown>,
): Promise<any> {
  const cacheKey = accountDetails
    ? `transferwise_required_bank_info_${host.id}_${currency}_${hashObject(
        pick(accountDetails, ['type', 'details.bankCode', 'details.legalType', 'details.address.country']),
      )}`
    : `transferwise_required_bank_info_${host.id}_to_${currency}`;
  const fromCache = await cache.get(cacheKey);
  if (fromCache) {
    return fromCache;
  }

  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

  const token = await getToken(connectedAccount);
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
      ? await transferwise.validateAccountRequirements(token, transactionParams, accountDetails)
      : await transferwise.getAccountRequirements(token, transactionParams);

  cache.set(cacheKey, requiredFields, 24 * 60 * 60 /* a whole day and we could probably increase */);
  return requiredFields;
}

async function getAccountBalances(connectedAccount: ConnectedAccount): Promise<Balance[]> {
  await populateProfileId(connectedAccount);
  const token = await getToken(connectedAccount);
  const account = await transferwise.getBorderlessAccount(token, <number>connectedAccount.data.id);
  return account?.balances || [];
}

const oauth = {
  redirectUrl: async function (
    user: { id: number },
    CollectiveId: string | number,
    query?: { redirect: string },
  ): Promise<string> {
    const hash = hashObject({ CollectiveId, userId: user.id });
    const cacheKey = `transferwise_oauth_${hash}`;
    await cache.set(cacheKey, { CollectiveId, redirect: query.redirect }, 60 * 10);
    return transferwise.getOAuthUrl(hash);
  },

  callback: async function (req: express.Request, res: express.Response): Promise<void> {
    const state = req.query?.state;
    if (!state) {
      res.sendStatus(401);
    }

    const cacheKey = `transferwise_oauth_${state}`;
    const originalRequest = await cache.get(cacheKey);
    if (!originalRequest) {
      const errorMessage = `TransferWise OAuth request not found or expired for state ${state}.`;
      logger.error(errorMessage);
      res.send(errorMessage);
      return;
    }

    const { redirect, CollectiveId } = originalRequest;
    const redirectUrl = new URL(redirect);
    try {
      const { code, profileId } = req.query;
      const accessToken = await transferwise.getOrRefreshToken({ code: code?.toString() });
      const { access_token: token, refresh_token: refreshToken, ...data } = accessToken;

      const existingConnectedAccount = await models.ConnectedAccount.findOne({
        where: { service: 'transferwise', CollectiveId },
      });

      if (existingConnectedAccount) {
        await existingConnectedAccount.update({
          token,
          refreshToken,
          data: { ...existingConnectedAccount.data, ...data },
        });
      } else {
        const connectedAccount = await models.ConnectedAccount.create({
          CollectiveId,
          service: 'transferwise',
          token,
          refreshToken,
          data,
        });
        await populateProfileId(connectedAccount, toNumber(profileId));
      }

      res.redirect(redirectUrl.href);
    } catch (e) {
      logger.error(`Error with TransferWise OAuth callback: ${e.message}`, { ...e, state });
      redirectUrl.searchParams.append(
        'error',
        `Could not OAuth with TransferWise, please contact support@opencollective.com. State: ${state}`,
      );
      res.redirect(redirectUrl.href);
    }
  },
};

async function setUpWebhook(): Promise<void> {
  const url = `${config.host.api}/webhooks/transferwise`;
  const existingWebhooks = await transferwise.listApplicationWebhooks();

  if (existingWebhooks?.find(w => w.trigger_on === 'transfers#state-change' && w.delivery.url === url)) {
    logger.info(`TransferWise App Webhook already exists for ${url}.`);
    return;
  }

  logger.info(`Creating TransferWise App Webhook on ${url}...`);
  await transferwise.createApplicationWebhook({
    name: 'Open Collective',
    // eslint-disable-next-line camelcase
    trigger_on: 'transfers#state-change',
    delivery: {
      version: '2.0.0',
      url,
    },
  });
}

export default {
  getAvailableCurrencies,
  getRequiredBankInformation,
  getAccountBalances,
  getTemporaryQuote,
  getToken,
  createRecipient,
  quoteExpense,
  payExpense,
  payExpensesBatchGroup,
  setUpWebhook,
  validatePayoutMethod,
  scheduleExpenseForPayment,
  unscheduleExpenseForPayment,
  oauth,
};
