/* eslint-disable camelcase */
import assert from 'assert';

import { isMemberOfTheEuropeanUnion } from '@opencollective/taxes';
import config from 'config';
import express from 'express';
import {
  cloneDeep,
  compact,
  difference,
  find,
  get,
  has,
  isUndefined,
  omit,
  omitBy,
  pick,
  random,
  round,
  set,
  split,
  toLower,
  toNumber,
} from 'lodash';
import moment from 'moment';
import { v4 as uuid } from 'uuid';

import activities from '../../constants/activities';
import { Service } from '../../constants/connected-account';
import { SupportedCurrency } from '../../constants/currencies';
import status from '../../constants/expense-status';
import { TransferwiseError } from '../../graphql/errors';
import cache, { sessionCache } from '../../lib/cache';
import { getFxRate } from '../../lib/currency';
import logger from '../../lib/logger';
import { centsAmountToFloat } from '../../lib/math';
import { safeJsonStringify } from '../../lib/safe-json-stringify';
import { reportErrorToSentry } from '../../lib/sentry';
import * as transferwise from '../../lib/transferwise';
import { Collective, ConnectedAccount, Expense, Op, PayoutMethod, sequelize, User } from '../../models';
import {
  BalanceV4,
  BatchGroup,
  ExpenseDataQuoteV2,
  ExpenseDataQuoteV3,
  QuoteV2PaymentOption,
  QuoteV3,
  QuoteV3PaymentOption,
  RecipientAccount,
  TransactionRequirementsType,
  Transfer,
  Webhook,
} from '../../types/transferwise';
import { hashObject } from '../utils';

import { handleTransferStateChange } from './webhook';

const PROVIDER_NAME = Service.TRANSFERWISE;

const splitCSV = string => compact(split(string, /,\s*/));

const blockedCountries = splitCSV(config.transferwise.blockedCountries);
const blockedCurrencies = splitCSV(config.transferwise.blockedCurrencies);
const blockedCurrenciesForBusinessProfiles = splitCSV(config.transferwise.blockedCurrenciesForBusinessProfiles);
const blockedCurrenciesForNonProfits = splitCSV(config.transferwise.blockedCurrenciesForNonProfits);

async function populateProfileId(connectedAccount: ConnectedAccount, profileId: number): Promise<void> {
  if (!connectedAccount.data?.id) {
    const profiles = await transferwise.getProfiles(connectedAccount);
    const personalProfile = profiles.find(p => p.type === 'PERSONAL');
    const businessProfile = profiles.find(p => p.id === profileId);
    if (businessProfile) {
      const hash = hashObject({
        profileId: businessProfile.id,
        service: PROVIDER_NAME,
        userId: personalProfile.userId,
      });
      const isOwner = businessProfile.type === 'BUSINESS' && businessProfile.companyRole === 'OWNER';
      await connectedAccount.update({
        data: { ...connectedAccount.data, ...businessProfile, personalProfile },
        hash,
        settings: { isOwner, userId: personalProfile.userId },
      });
    } else {
      throw new Error(`Could not find a Wise profile for connected account ${connectedAccount.id}`);
    }
  }
}

async function getTemporaryQuote(
  connectedAccount: ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: Expense,
): Promise<QuoteV3> {
  expense.collective = expense.collective || (await Collective.findByPk(expense.CollectiveId));
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
  transferNature?: string,
): Promise<ExpenseDataQuoteV3 | ExpenseDataQuoteV2> {
  const existingQuote = expense.data?.quote;
  const isExistingQuoteValid =
    expense.feesPayer !== 'PAYEE' &&
    transferNature === undefined &&
    existingQuote &&
    // We want a paymentOption to be there
    existingQuote['paymentOption'] &&
    // We cannot use quotes that don't have a valid paymentOption
    existingQuote['paymentOption'].disabled === false &&
    // Make sure this is not a temporoary quote and it points to the correct Target Account
    'targetAccount' in existingQuote &&
    existingQuote.targetAccount === expense.data.recipient?.id &&
    (targetAccount === undefined || existingQuote.targetAccount === targetAccount) &&
    // We can not reuse quotes if a Transfer was already created
    !expense.data.transfer &&
    moment.utc().subtract(60, 'seconds').isBefore(existingQuote['expirationTime']);
  if (isExistingQuoteValid) {
    logger.debug(`quoteExpense(): reusing existing quote...`);
    return <ExpenseDataQuoteV3 | ExpenseDataQuoteV2>existingQuote;
  }

  expense.collective = expense.collective || (await Collective.findByPk(expense.CollectiveId));
  expense.host = expense.host || (await expense.collective.getHostCollective());
  const hasMultiCurrency = expense.currency !== expense.collective.currency;
  const targetCurrency = payoutMethod.unfilteredData.currency as string;
  const quoteParams = {
    profileId: connectedAccount.data.id,
    // Attention: sourceCurrency must always be the host currency, we count with this when persisting the Processor Payment Fee
    sourceCurrency: expense.host.currency,
    targetCurrency,
    ...omitBy<Partial<Parameters<typeof transferwise.createQuote>[1]>>(
      {
        targetAccount,
        paymentMetadata: transferNature ? { transferNature } : undefined,
      },
      isUndefined,
    ),
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

async function validateTransferRequirements(
  connectedAccount: ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: Expense,
  details: transferwise.CreateTransfer['details'],
): Promise<TransactionRequirementsType[]> {
  if (!payoutMethod) {
    payoutMethod = await expense.getPayoutMethod();
  }
  const recipient =
    get(expense.data, 'recipient.payoutMethodId') === payoutMethod.id
      ? (expense.data.recipient as RecipientAccount)
      : await createRecipient(connectedAccount, payoutMethod);

  await expense.update({ data: { ...expense.data, recipient } });
  const quote = await quoteExpense(connectedAccount, payoutMethod, expense, recipient.id);
  return await transferwise.validateTransferRequirements(connectedAccount, {
    accountId: recipient.id,
    quoteUuid: quote.id,
    details,
  });
}

async function createTransfer(
  connectedAccount: ConnectedAccount,
  payoutMethod: PayoutMethod,
  expense: Expense,
  options?: { token?: string; batchGroupId?: string; details?: transferwise.CreateTransfer['details'] },
): Promise<{
  quote: ExpenseDataQuoteV2 | ExpenseDataQuoteV3;
  recipient: RecipientAccount;
  transfer: Transfer;
  paymentOption: QuoteV2PaymentOption | QuoteV3PaymentOption;
}> {
  if (!payoutMethod) {
    payoutMethod = await expense.getPayoutMethod();
  }

  const recipient =
    get(expense.data, 'recipient.payoutMethodId') === payoutMethod.id
      ? (expense.data.recipient as RecipientAccount)
      : await createRecipient(connectedAccount, payoutMethod);

  const transferNature = options?.details?.transferNature;
  const quote = await quoteExpense(connectedAccount, payoutMethod, expense, recipient.id, transferNature);
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
      details: {
        reference: `${expense.id}`,
        ...options?.details,
      },
    };

    const transfer = options?.batchGroupId
      ? await transferwise.createBatchGroupTransfer(connectedAccount, options.batchGroupId, transferOptions)
      : await transferwise.createTransfer(connectedAccount, transferOptions);

    await expense.update({
      data: {
        ...expense.data,
        quote: omit(quote, ['paymentOptions']) as ExpenseDataQuoteV3,
        recipient,
        transfer,
        paymentOption,
      },
    });

    return { quote, recipient, transfer, paymentOption };
  } catch (e) {
    logger.error(`Wise: Error creating transaction for expense: ${expense.id}`, e);
    await expense.update({ status: status.ERROR });
    const user = await User.findByPk(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR, user, {
      error: { message: e.message, details: safeJsonStringify(e) },
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
  transferDetails?: transferwise.CreateTransfer['details'],
): Promise<{
  quote: ExpenseDataQuoteV2 | ExpenseDataQuoteV3;
  recipient: RecipientAccount;
  fund: { status: string; errorCode: string };
  transfer: Transfer;
  paymentOption: QuoteV2PaymentOption | QuoteV3PaymentOption;
}> {
  const token = await transferwise.getToken(connectedAccount);
  const { quote, recipient, transfer, paymentOption } = await createTransfer(connectedAccount, payoutMethod, expense, {
    batchGroupId,
    token,
    details: transferDetails,
  });

  let fund;
  try {
    fund = await transferwise.fundTransfer(connectedAccount, {
      transferId: transfer.id,
    });

    // Simulate transfer success in other environments so transactions don't get stuck.
    if (['development', 'staging'].includes(config.env)) {
      const response = await transferwise.simulateTransferSuccess(connectedAccount, transfer.id);
      await expense.update({ data: { ...expense.data, transfer: response } });

      // In development mode we don't have webhooks set up, so we need to manually trigger the event handler.
      if (config.env === 'development') {
        await handleTransferStateChange({
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
  host: Collective,
  options?: { connectedAccount?: ConnectedAccount; token?: string },
): Promise<BatchGroup> => {
  const expense = await Expense.findOne({
    where: { status: status.SCHEDULED_FOR_PAYMENT, data: { batchGroup: { status: 'NEW' } } },
    order: [['updatedAt', 'DESC']],
    include: [
      { model: PayoutMethod, as: 'PayoutMethod', required: true },
      {
        model: Collective,
        as: 'collective',
        where: { HostCollectiveId: host.id },
        required: true,
      },
    ],
  });

  const connectedAccount = options?.connectedAccount || (await host.getAccountForPaymentProvider(PROVIDER_NAME));
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

async function scheduleExpenseForPayment(
  expense: Expense,
  transferDetails?: transferwise.CreateTransfer['details'],
  remoteUser?: User,
): Promise<Expense> {
  const collective = await expense.getCollective();
  const host = await collective.getHostCollective();
  if (!host) {
    throw new Error(`Can not find Host for expense ${expense.id}`);
  }

  if (collective.currency !== host.currency) {
    throw new Error('Can not batch an expense with a currency different from its host currency');
  }
  if (!expense.PayoutMethod) {
    expense.PayoutMethod = await expense.getPayoutMethod();
  }

  const transferNature = transferDetails?.transferNature;
  const connectedAccount = await host.getAccountForPaymentProvider(PROVIDER_NAME, {
    CreatedByUserId: remoteUser?.id,
    fallbackToNonUserAccount: true,
  });
  const token = await transferwise.getToken(connectedAccount);
  const [wiseBalances, quote] = await Promise.all([
    getAccountBalances(host, { connectedAccount }),
    quoteExpense(connectedAccount, expense.PayoutMethod, expense, undefined, transferNature),
  ]);
  const balanceInSourceCurrency = wiseBalances.find(b => b.currency === quote.sourceCurrency);

  // Check for any existing Batch Group where status = NEW, create a new one if needed
  let batchGroup = await getOrCreateActiveBatch(host, { connectedAccount, token });
  assert(batchGroup?.id, 'Failed to create new batch group');
  let totalAmountToPay = quote.paymentOption.sourceAmount;
  if (batchGroup.transferIds.length > 0) {
    const batchedExpenses = await Expense.findAll({
      where: { data: { batchGroup: { id: batchGroup.id } } },
    });
    totalAmountToPay += batchedExpenses.reduce((total, e) => total + e.data.quote.paymentOption.sourceAmount, 0);
  }

  const roundedTotalAmountToPay = round(totalAmountToPay, 2); // To prevent floating point errors
  assert(
    balanceInSourceCurrency.amount.value >= roundedTotalAmountToPay,
    `Insufficient balance in ${quote.sourceCurrency} to cover the existing batch plus this expense amount, you need ${roundedTotalAmountToPay} ${quote.sourceCurrency} and you currently have ${balanceInSourceCurrency.amount.value} ${balanceInSourceCurrency.amount.currency}. Please add funds to your Wise ${quote.sourceCurrency} account.`,
  );

  const { transfer } = await createTransfer(connectedAccount, expense.PayoutMethod, expense, {
    batchGroupId: batchGroup.id,
    token,
    details: transferDetails,
  });

  batchGroup = await transferwise.getBatchGroup(connectedAccount, batchGroup.id);
  assert(batchGroup.transferIds.includes(transfer.id), new Error('Failed to add transfer to existing batch group'));
  await expense.reload();
  await expense.update({ data: { ...expense.data, batchGroup } });
  await updateBatchGroup(batchGroup);
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

  const connectedAccount = await host.getAccountForPaymentProvider(PROVIDER_NAME);

  const batchGroup = await transferwise.getBatchGroup(connectedAccount, expense.data.batchGroup['id']);
  const expensesInBatch = await Expense.findAll({
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

const updateBatchGroup = async (batchGroup: BatchGroup): Promise<void> => {
  assert(batchGroup.id, 'Batch group id is required');
  return await sequelize.query(
    `
        UPDATE "Expenses" SET "data" = JSONB_SET("data", '{batchGroup}', :newBatchGroup::JSONB) WHERE
        "data"#>>'{batchGroup, id}' = :batchGroupId;
      `,
    {
      replacements: {
        newBatchGroup: JSON.stringify(batchGroup),
        batchGroupId: batchGroup.id,
      },
    },
  );
};

async function payExpensesBatchGroup({
  host,
  expenses,
  remoteUser,
}: {
  host: Collective;
  expenses: Expense[];
  remoteUser: User;
}) {
  assert(expenses.length > 0, 'No expenses provided to pay');
  const connectedAccount = await host.getAccountForPaymentProvider(Service.TRANSFERWISE, {
    CreatedByUserId: remoteUser.id,
    fallbackToNonUserAccount: true,
  });
  assert(connectedAccount, `No connected account found for host ${host.id} and user ${remoteUser.id}`);

  const profileId = connectedAccount.data.id;
  const token = await transferwise.getToken(connectedAccount);

  try {
    let batchGroup = await transferwise.getBatchGroup(connectedAccount, expenses[0].data.batchGroup.id);
    // Throw if batch group was already paid
    if (batchGroup.status === 'COMPLETED' && batchGroup.alreadyPaid === true) {
      throw new Error('Can not pay batch group, existing batch group was already paid');
    }
    // Throw if batch group is cancelled
    else if (['MARKED_FOR_CANCELLATION', 'PROCESSING_CANCEL', 'CANCELLED'].includes(batchGroup.status)) {
      throw new Error(`Can not pay batch group, existing batch group was cancelled`);
    }
    // If it is new, check if the expenses match the batch group and mark it as completed
    else if (batchGroup.status === 'NEW') {
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
      await updateBatchGroup(batchGroup);
    }
    // If it is completed, fund it and forward the OTT
    const fundResponse = await transferwise.fundBatchGroup(token, profileId, batchGroup.id);
    if ('status' in fundResponse && 'headers' in fundResponse) {
      const cacheKey = `transferwise_ott_${fundResponse.headers['x-2fa-approval']}`;
      await sessionCache.set(cacheKey, batchGroup.id, 30 * 60);
    }
    return fundResponse;
  } catch (e) {
    logger.error('Error paying Wise batch group', e);
    throw e;
  }
}

async function approveExpenseBatchGroupPayment({
  host,
  x2faApproval,
  remoteUser,
}: {
  host: Collective;
  x2faApproval: string;
  remoteUser: User;
}) {
  const connectedAccount = await host.getAccountForPaymentProvider(Service.TRANSFERWISE, {
    CreatedByUserId: remoteUser.id,
    fallbackToNonUserAccount: true,
  });
  assert(connectedAccount, `No connected account found for host ${host.id} and user ${remoteUser.id}`);

  const profileId = connectedAccount.data.id;
  const token = await transferwise.getToken(connectedAccount);
  try {
    const cacheKey = `transferwise_ott_${x2faApproval}`;
    const batchGroupId = await sessionCache.get(cacheKey);
    if (!batchGroupId) {
      throw new Error('Invalid or expired OTT approval code');
    }
    const batchGroup = (await transferwise.fundBatchGroup(token, profileId, batchGroupId, x2faApproval)) as BatchGroup;
    await sessionCache.delete(cacheKey);
    await updateBatchGroup(batchGroup);
    return batchGroup;
  } catch (e) {
    logger.error('Error approving Wise batch group payment', e);
    throw e;
  }
}

async function getAvailableCurrencies(
  host: Collective,
  ignoreBlockedCurrencies = true,
): Promise<{ code: string; minInvoiceAmount: number }[]> {
  const connectedAccount = await host.getAccountForPaymentProvider(PROVIDER_NAME);

  let currencyBlockList = [];
  if (ignoreBlockedCurrencies) {
    currencyBlockList = blockedCurrencies;
    if (toLower(connectedAccount.data?.type) === 'business') {
      currencyBlockList = [...currencyBlockList, ...blockedCurrenciesForBusinessProfiles];
    }
    if (connectedAccount.data?.firstLevelCategory === 'CHARITY_NON_PROFIT') {
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
    connectedAccount.data?.firstLevelCategory === 'CHARITY_NON_PROFIT' &&
    blockedCurrenciesForNonProfits.includes(currency)
  ) {
    throw new Error(`Sorry, this host's non profit corporation can not create a transaction to ${currency}`);
  }
  if (connectedAccount.data?.blockedCurrencies?.includes(currency)) {
    throw new Error(`Sorry, this host's account can not create a transaction to ${currency}`);
  }
}

async function getRequiredBankInformation(
  host: Collective,
  currency: SupportedCurrency,
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

  const connectedAccount = await host.getAccountForPaymentProvider(PROVIDER_NAME);

  const currencyInfo = find(await getAvailableCurrencies(host), { code: currency });
  if (!currencyInfo) {
    throw new TransferwiseError('This currency is not supported', 'transferwise.error.currencyNotSupported');
  }

  const transactionParams = {
    sourceCurrency: host.currency,
    targetCurrency: currency,
    sourceAmount: currencyInfo.minInvoiceAmount * 20,
  };

  let requiredFields =
    accountDetails && has(accountDetails, 'details')
      ? await transferwise.validateAccountRequirements(connectedAccount, transactionParams, accountDetails)
      : await transferwise.getAccountRequirements(connectedAccount, transactionParams);

  // Filter out methods blocked by Host settings
  if (host.settings?.transferwise?.blockedPaymentMethodTypes) {
    requiredFields = requiredFields.filter(
      ({ type }) => !host.settings.transferwise.blockedPaymentMethodTypes.includes(type),
    );
  }

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

async function getAccountBalances(
  host: Collective,
  options?: { connectedAccount: ConnectedAccount },
): Promise<BalanceV4[]> {
  const connectedAccount = options?.connectedAccount ?? (await host.getAccountForPaymentProvider(PROVIDER_NAME));
  assert(connectedAccount, `No connected account found for host ${host.id}`);
  return transferwise.listBalancesAccount(connectedAccount);
}

const oauth = {
  redirectUrl: async function (
    user: User,
    CollectiveId: string | number,
    query?: { redirect: string },
  ): Promise<string> {
    if (!this.rolesByCollectiveId) {
      await user.populateRoles();
    }
    assert(user.isAdmin(CollectiveId), 'User must be an admin of the Collective');

    const state = hashObject({ CollectiveId, userId: user.id, nonce: random(100000) });
    await sessionCache.set(
      `transferwise_oauth_${state}`,
      { CollectiveId, redirect: query.redirect, UserId: user.id },
      60 * 10,
    );
    return transferwise.getOAuthUrl(state);
  },

  callback: async function (req: express.Request, res: express.Response): Promise<void> {
    const state = req.query?.state;
    if (!state) {
      res.sendStatus(401);
    }

    const cacheKey = `transferwise_oauth_${state}`;
    const originalRequest = await sessionCache.get(cacheKey);
    if (!originalRequest) {
      const errorMessage = `TransferWise OAuth request not found or expired for state ${state}.`;
      logger.error(errorMessage);
      res.send(errorMessage);
      return;
    }

    const { redirect, CollectiveId, UserId: CreatedByUserId } = originalRequest;
    const redirectUrl = new URL(redirect);
    try {
      const { code, profileId } = req.query;
      const accessToken = await transferwise.getOrRefreshToken({ code: code?.toString() });
      const { access_token: token, refresh_token: refreshToken, ...data } = accessToken;
      const connectedAccount = ConnectedAccount.build({
        CollectiveId,
        CreatedByUserId,
        service: PROVIDER_NAME,
        token,
        refreshToken,
        data,
      });
      const profiles = await transferwise.getProfiles(connectedAccount);
      const personalProfile = profiles.find(p => p.type === 'PERSONAL');
      const profile = profiles.find(p => p.id === toNumber(profileId));
      assert(profile, `Could not find Wise profile with id ${profileId}`);
      const hash = hashObject({ profileId: profile.id, service: PROVIDER_NAME, userId: personalProfile.userId });

      const collective = await Collective.findByPk(CollectiveId);
      assert(collective, `Could not find Collective #${CollectiveId}`);
      const existingConflicts = await ConnectedAccount.findOne({
        where: { service: PROVIDER_NAME, data: { id: { [Op.ne]: profile.id } }, CollectiveId },
      });
      assert(
        !existingConflicts,
        `This Collective is already connected to a different Wise account. Please disconnect it first.`,
      );

      // Check if this account was already connected to another collective, if so, we'll mirror it to that Account so we avoid invalidating tokens.
      const mirroredAccounts = await ConnectedAccount.findAll({
        where: { service: PROVIDER_NAME, data: { id: profile.id }, CollectiveId: { [Op.ne]: collective.id } },
        include: [{ model: Collective, as: 'collective' }],
      });

      // Link to existing connected account if the profileId is already connected to another collective
      if (mirroredAccounts.length > 0) {
        const mirroredAccount = mirroredAccounts.find(
          mirroredAccount => mirroredAccount.CreatedByUserId === CreatedByUserId,
        );
        assert(mirroredAccount, 'You can only mirror accounts that were previously connected by your user');
        logger.warn(
          `${collective.slug} connected a Wise account that is already connected to another collective, linking to existing account ${mirroredAccount.id}`,
        );
        const user = await User.findByPk(CreatedByUserId);
        await user.populateRoles();
        assert(
          user.isAdmin(mirroredAccount.CollectiveId),
          'This account is already connected to another Collective, make sure you have the right permissions on the other Collective',
        );

        const mirrorHash = hashObject({
          profileId: profile.id,
          service: 'transferwise',
          userId: profile.userId,
          MirrorConnectedAccountId: mirroredAccount.id,
        });
        const existingConnectedAccount = await ConnectedAccount.findOne({
          where: { service: PROVIDER_NAME, CollectiveId, hash: mirrorHash },
        });
        // If mirror account already exists, update it with new tokens
        if (existingConnectedAccount) {
          await existingConnectedAccount.update({ token, refreshToken });
        } else {
          // Create a new empty connected account pointing to the existing one that ports the same credentials
          await ConnectedAccount.create({
            CollectiveId,
            CreatedByUserId: CreatedByUserId,
            service: PROVIDER_NAME,
            token: null,
            refreshToken: null,
            hash: mirrorHash,
            data: {
              MirrorConnectedAccountId: mirroredAccount.id,
            },
            settings: { isMirror: true, mirroredCollective: mirroredAccount.collective.minimal },
          });
        }

        // Update the original connected account with the new tokens
        await mirroredAccount.update({
          token,
          refreshToken,
          data: { ...mirroredAccount.data, ...data },
        });
        await populateProfileId(mirroredAccount, profile.id);
      }
      // Otherwise update the existing connected account or create a new one
      else {
        let connectedAccount = await ConnectedAccount.findOne({
          where: { service: PROVIDER_NAME, CollectiveId, hash },
        });
        if (connectedAccount) {
          await connectedAccount.update({
            token,
            refreshToken,
            data: { ...connectedAccount.data, ...data },
            hash,
          });
        } else {
          connectedAccount = await ConnectedAccount.create({
            CollectiveId,
            CreatedByUserId: CreatedByUserId,
            service: PROVIDER_NAME,
            token,
            refreshToken,
            data,
            hash,
          });
        }
        await populateProfileId(connectedAccount, profile.id);
      }

      // Automatically set OTT flag on for European contries and Australia.
      if (
        (collective.countryISO &&
          (isMemberOfTheEuropeanUnion(collective.countryISO) || ['AU', 'GB'].includes(collective.countryISO))) ||
        ['AUD', 'DKK', 'EUR', 'GBP', 'SEK'].includes(collective.currency) ||
        config.env === 'development'
      ) {
        const settings = collective.settings ? cloneDeep(collective.settings) : {};
        set(settings, 'transferwise.ott', true);
        await collective.update({ settings });
      }

      // Clear cached authorization state key
      await sessionCache.delete(cacheKey);

      res.redirect(redirectUrl.href);
    } catch (e) {
      logger.error(`Error with Wise OAuth callback: ${e.message}`, { ...e, state });
      reportErrorToSentry(e);
      redirectUrl.searchParams.append(
        'error',
        `Could not OAuth with Wise: ${e.message}. Please contact support@opencollective.com. State: ${state}`,
      );
      res.redirect(redirectUrl.href);
    }
  },
};

async function createWebhooksForHost(url = `${config.host.api}/webhooks/transferwise`): Promise<Webhook[]> {
  const existingWebhooks = await transferwise.listApplicationWebhooks();

  const requiredHooks = [
    {
      trigger_on: 'transfers#state-change',
      delivery: {
        version: '2.0.0',
        url,
      },
    },
    {
      trigger_on: 'transfers#refund',
      delivery: {
        version: '1.0.0',
        url,
      },
    },
  ] as const;

  const webhooks = [];
  for (const hook of requiredHooks) {
    const existingWebhook = existingWebhooks?.find(
      existingHook => existingHook.trigger_on === hook.trigger_on && existingHook.delivery.url === hook.delivery.url,
    );
    if (existingWebhook) {
      logger.info(`TransferWise App Webhook already exists for ${url}.`);
      webhooks.push(existingWebhook);
      continue;
    }

    logger.info(`Creating TransferWise App Webhook on ${hook.delivery.url} for ${hook.trigger_on} events...`);
    const webhook = await transferwise.createApplicationWebhook({
      name: 'Open Collective',
      ...hook,
    });
    webhooks.push(webhook);
  }
  return webhooks;
}

async function removeWebhooksForHost() {
  logger.info(`Removing TransferWise Webhooks for ${config.host.api}...`);
  const existingWebhooks = (await transferwise.listApplicationWebhooks()) || [];
  await Promise.all(
    existingWebhooks
      .filter(w => w.delivery.url.includes(config.host.api))
      .map(async w => {
        await transferwise.deleteApplicationWebhook(w.id);
        logger.info(`Removed TransferWise Webhook for event ${w.trigger_on} ${w.delivery.url}`);
      }),
  );
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
  approveExpenseBatchGroupPayment,
  createWebhooksForHost,
  validatePayoutMethod,
  scheduleExpenseForPayment,
  unscheduleExpenseForPayment,
  validateTransferRequirements,
  removeWebhooksForHost,
  oauth,
};
