import assert from 'assert';
import crypto from 'crypto';

import { isMemberOfTheEuropeanUnion } from '@opencollective/taxes';
import config from 'config';
import express from 'express';
import { cloneDeep, compact, difference, find, get, has, omit, pick, set, split, toNumber } from 'lodash';
import moment from 'moment';
import { v4 as uuid } from 'uuid';

import activities from '../../constants/activities';
import status from '../../constants/expense_status';
import { TransferwiseError } from '../../graphql/errors';
import cache from '../../lib/cache';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { centsAmountToFloat } from '../../lib/math';
import { reportErrorToSentry } from '../../lib/sentry';
import * as transferwise from '../../lib/transferwise';
import models, { sequelize } from '../../models';
import { ConnectedAccount } from '../../models/ConnectedAccount';
import Expense from '../../models/Expense';
import PayoutMethod from '../../models/PayoutMethod';
import {
  BalanceV4,
  BatchGroup,
  ExpenseDataQuoteV2,
  QuoteV2,
  QuoteV2PaymentOption,
  RecipientAccount,
  TransactionRequirementsType,
  Transfer,
} from '../../types/transferwise';

import { handleTransferStateChange } from './webhook';

const providerName = 'transferwise';

const hashObject = obj => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 7);
const splitCSV = string => compact(split(string, /,\s*/));

export const blockedCountries = splitCSV(config.transferwise.blockedCountries);
export const blockedCurrencies = splitCSV(config.transferwise.blockedCurrencies);
export const blockedCurrenciesForBusinessProfiles = splitCSV(config.transferwise.blockedCurrenciesForBusinessProfiles);
export const blockedCurrenciesForNonProfits = splitCSV(config.transferwise.blockedCurrenciesForNonProfits);
export const currenciesThatRequireReference = ['RUB'];

async function populateProfileId(connectedAccount: ConnectedAccount, profileId?: number): Promise<void> {
  if (!connectedAccount.data?.id) {
    const profiles = await transferwise.getProfiles(connectedAccount);
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
  connectedAccount: ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: Expense,
): Promise<QuoteV2> {
  expense.collective = expense.collective || (await models.Collective.findByPk(expense.CollectiveId));
  expense.host = expense.host || (await expense.collective.getHostCollective());
  const rate = await getFxRate(expense.currency, expense.host.currency);
  return await transferwise.getTemporaryQuote(connectedAccount, {
    sourceCurrency: expense.host.currency,
    targetCurrency: <string>payoutMethod.unfilteredData.currency,
    sourceAmount: centsAmountToFloat(expense.amount * rate),
  });
}

async function createRecipient(
  connectedAccount: ConnectedAccount,
  payoutMethod: PayoutMethod,
): Promise<RecipientAccount & { payoutMethodId: number }> {
  const recipient = await transferwise.createRecipientAccount(connectedAccount, {
    ...(<RecipientAccount>payoutMethod.data),
  });

  return { ...recipient, payoutMethodId: payoutMethod.id };
}

async function quoteExpense(
  connectedAccount: ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: Expense,
  targetAccount?: number,
): Promise<ExpenseDataQuoteV2> {
  await populateProfileId(connectedAccount);

  const isExistingQuoteValid =
    expense.data?.quote &&
    expense.data.quote['paymentOption'] &&
    !expense.data.transfer && // We can not reuse quotes if a Transfer was already created
    moment.utc().subtract(60, 'seconds').isBefore(expense.data.quote['expirationTime']);
  if (isExistingQuoteValid) {
    logger.debug(`quoteExpense(): reusing existing quote...`);
    return <ExpenseDataQuoteV2>expense.data.quote;
  }

  expense.collective = expense.collective || (await models.Collective.findByPk(expense.CollectiveId));
  expense.host = expense.host || (await expense.collective.getHostCollective());
  const hasMultiCurrency = expense.currency !== expense.collective.currency;
  const targetCurrency = payoutMethod.unfilteredData.currency as string;
  const quoteParams = {
    profileId: connectedAccount.data.id,
    sourceCurrency: expense.host.currency,
    targetCurrency,
    targetAccount,
  };

  if (hasMultiCurrency) {
    assert(
      expense.collective.currency === expense.host.currency,
      'For multi-currency expenses, the host currency must be the same as the collective currency',
    );
    assert(
      expense.currency === targetCurrency,
      'For multi-currency expenses, the payout currency must be the same as the expense currency',
    );
    quoteParams['targetCurrency'] = expense.currency;
    quoteParams['targetAmount'] = expense.amount / 100;
  } else if (expense.feesPayer === 'PAYEE') {
    // Using "else if" because customizing the fee payer is not allowed for multi-currency expenses. See `getCanCustomizeFeesPayer`.
    assert(
      expense.host.currency === expense.currency,
      'For expenses where fees are covered by the payee, the host currency must be the same as the expense currency',
    );
    quoteParams['sourceAmount'] = expense.amount / 100;
  } else {
    const targetAmount = expense.amount;
    // Convert Expense amount to targetCurrency
    if (targetCurrency !== expense.currency) {
      const [exchangeRate] = await transferwise.getExchangeRates(connectedAccount, expense.currency, targetCurrency);
      quoteParams['targetAmount'] = centsAmountToFloat(targetAmount * exchangeRate.rate);
    } else {
      quoteParams['targetAmount'] = centsAmountToFloat(targetAmount);
    }
  }

  const quote = await transferwise.createQuote(connectedAccount, quoteParams);
  const paymentOption = quote.paymentOptions.find(p => p.payIn === 'BALANCE' && p.payOut === quote.payOut);
  const expenseDataQuote = { ...omit(quote, ['paymentOptions']), paymentOption };
  await expense.update({ data: { ...expense.data, quote: expenseDataQuote } });
  return expenseDataQuote;
}

async function createTransfer(
  connectedAccount: ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: Expense,
  options?: { token?: string; batchGroupId?: string },
): Promise<{
  quote: ExpenseDataQuoteV2;
  recipient: RecipientAccount;
  transfer: Transfer;
  paymentOption: QuoteV2PaymentOption;
}> {
  if (!payoutMethod) {
    payoutMethod = await expense.getPayoutMethod();
  }

  const recipient =
    get(expense.data, 'recipient.payoutMethodId') === payoutMethod.id
      ? (expense.data.recipient as RecipientAccount)
      : await createRecipient(connectedAccount, payoutMethod);

  const quote = await quoteExpense(connectedAccount, payoutMethod, expense, recipient.id);
  const paymentOption = quote['paymentOption'];
  if (!paymentOption || paymentOption.disabled) {
    const message =
      paymentOption?.disabledReason?.message ||
      `We can't find a compatible wise payment method for this transaction. Please re-connecte Wise or contact support at support@opencollective.com`;
    throw new TransferwiseError(message, null, { quote });
  }

  try {
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
      ? await transferwise.createBatchGroupTransfer(connectedAccount, options.batchGroupId, transferOptions)
      : await transferwise.createTransfer(connectedAccount, transferOptions);

    await expense.update({
      data: { ...expense.data, quote: omit(quote, ['paymentOptions']), recipient, transfer, paymentOption },
    });

    return { quote, recipient, transfer, paymentOption };
  } catch (e) {
    logger.error(`Wise: Error creating transaction for expense: ${expense.id}`, e);
    await expense.update({ status: status.ERROR });
    const user = await models.User.findByPk(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, user, {
      error: { message: e.message },
      isSystem: true,
    });
    throw e;
  }
}

async function payExpense(
  connectedAccount: ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: Expense,
  batchGroupId?: string,
): Promise<{
  quote: ExpenseDataQuoteV2;
  recipient: RecipientAccount;
  fund: { status: string; errorCode: string };
  transfer: Transfer;
  paymentOption: QuoteV2PaymentOption;
}> {
  const token = await transferwise.getToken(connectedAccount);
  const { quote, recipient, transfer, paymentOption } = await createTransfer(connectedAccount, payoutMethod, expense, {
    batchGroupId,
    token,
  });

  let fund;
  try {
    fund = await transferwise.fundTransfer(connectedAccount, {
      transferId: transfer.id,
    });

    // Simulate transfer success in other environments so transactions don't get stuck.
    if (!transferwise.isProduction) {
      const response = await transferwise.simulateTransferSuccess(connectedAccount, transfer.id);
      await expense.update({ data: { ...expense.data, transfer: response } });

      // In development mode we don't have webhooks set up, so we need to manually trigger the event handler.
      if (config.env === 'development') {
        await handleTransferStateChange({
          // eslint-disable-next-line camelcase
          data: { resource: response, current_state: 'outgoing_payment_sent' },
        } as any);
      }
    }
  } catch (e) {
    logger.error(`Wise: Error paying expense ${expense.id}`, e);
    await transferwise.cancelTransfer(connectedAccount, transfer.id);
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

  const connectedAccount = options?.connectedAccount || (await host.getAccountForPaymentProvider(providerName));
  if (expense) {
    const batchGroup = await transferwise.getBatchGroup(connectedAccount, expense.data.batchGroup['id']);
    if (batchGroup.status === 'NEW') {
      return batchGroup;
    }
  }

  return transferwise.createBatchGroup(connectedAccount, {
    name: uuid(),
    sourceCurrency: connectedAccount.data.currency || host.currency,
  });
};

async function scheduleExpenseForPayment(expense: Expense): Promise<Expense> {
  const collective = await expense.getCollective();
  const host = await collective.getHostCollective();
  if (!host) {
    throw new Error(`Can not find Host for expense ${expense.id}`);
  }

  if (collective.currency !== host.currency) {
    throw new Error('Can not batch an expense with a currency different from its host currency');
  }

  const connectedAccount = await host.getAccountForPaymentProvider(providerName);
  const token = await transferwise.getToken(connectedAccount);

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

async function unscheduleExpenseForPayment(expense: Expense): Promise<void> {
  if (!expense.data.batchGroup) {
    throw new Error(`Expense does not belong to any batch group`);
  }

  const collective = await expense.getCollective();
  const host = await collective.getHostCollective();
  if (!host) {
    throw new Error(`Can not find Host for expense ${expense.id}`);
  }

  const connectedAccount = await host.getAccountForPaymentProvider(providerName);

  const batchGroup = await transferwise.getBatchGroup(connectedAccount, expense.data.batchGroup['id']);
  const expensesInBatch = await models.Expense.findAll({
    where: { data: { batchGroup: { id: batchGroup.id } } },
  });

  logger.warn(`Wise: canceling batchGroup ${batchGroup.id} with ${expensesInBatch.length} for host ${host.slug}`);
  await transferwise.cancelBatchGroup(connectedAccount, batchGroup.id, batchGroup.version);
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
  const token = await transferwise.getToken(connectedAccount);

  try {
    if (!x2faApproval && expenses) {
      let batchGroup = await transferwise.getBatchGroup(connectedAccount, expenses[0].data.batchGroup.id);
      if (batchGroup.status !== 'NEW') {
        throw new Error('Can not pay batch group, existing batch group was already processed');
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

      batchGroup = await transferwise.completeBatchGroup(connectedAccount, batchGroup.id, batchGroup.version);

      // Update batchGroup status to make sure we don't try to reuse a completed batchGroup
      await sequelize.query(
        `
        UPDATE "Expenses" SET "data" = JSONB_SET("data", '{batchGroup}', :newBatchGroup::JSONB) WHERE "id" IN (:expenseIds) AND "data"#>>'{batchGroup, id}' = :batchGroupId;
      `,
        {
          replacements: {
            expenseIds: expenses.map(e => e.id),
            newBatchGroup: JSON.stringify(batchGroup),
            batchGroupId: batchGroup.id,
          },
        },
      );

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

  await populateProfileId(connectedAccount);

  const pairs = await transferwise.getCurrencyPairs(connectedAccount);
  const source = pairs.sourceCurrencies.find(sc => sc.currencyCode === host.currency);
  const currencies = source.targetCurrencies.map(c => ({ code: c.currencyCode, minInvoiceAmount: c.minInvoiceAmount }));
  cache.set(cacheKey, currencies, 24 * 60 * 60 /* a whole day and we could probably increase */);
  return currencies.filter(c => !currencyBlockList.includes(c.code));
}

function validatePayoutMethod(connectedAccount: ConnectedAccount, payoutMethod: PayoutMethod): void {
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
): Promise<Array<TransactionRequirementsType>> {
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
      ? await transferwise.validateAccountRequirements(connectedAccount, transactionParams, accountDetails)
      : await transferwise.getAccountRequirements(connectedAccount, transactionParams);

  // Filter out countries blocked by sanctions on Wise
  requiredFields?.forEach?.((type, itype) => {
    type.fields?.forEach?.((field, ifield) => {
      field.group?.forEach?.((group, igroup) => {
        if (group?.key === 'address.country') {
          requiredFields[itype].fields[ifield].group[igroup].valuesAllowed = group.valuesAllowed.filter(
            value => !blockedCountries.includes(value.key),
          );
        }
      });
    });
  });

  cache.set(cacheKey, requiredFields, 24 * 60 * 60 /* a whole day and we could probably increase */);
  return requiredFields;
}

async function getAccountBalances(connectedAccount: ConnectedAccount): Promise<BalanceV4[]> {
  await populateProfileId(connectedAccount);
  return transferwise.listBalancesAccount(connectedAccount);
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
      const collective = await models.Collective.findByPk(CollectiveId);
      if (!collective) {
        throw new Error(`Could not find Collective #${CollectiveId}`);
      }
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

      // Automatically set OTT flag on for European contries and Australia.
      if (
        collective.countryISO &&
        (isMemberOfTheEuropeanUnion(collective.countryISO) || collective.countryISO === 'AU')
      ) {
        const settings = collective.settings ? cloneDeep(collective.settings) : {};
        set(settings, 'transferwise.ott', true);
        await collective.update({ settings });
      }

      res.redirect(redirectUrl.href);
    } catch (e) {
      logger.error(`Error with TransferWise OAuth callback: ${e.message}`, { ...e, state });
      reportErrorToSentry(e);
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
