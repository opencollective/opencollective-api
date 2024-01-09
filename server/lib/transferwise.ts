/* eslint-disable camelcase */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';

import axios, { AxiosError, AxiosResponse } from 'axios';
import config from 'config';
import Debug from 'debug';
import { Request } from 'express';
import { cloneDeep, isNull, omitBy, pick, set, startCase, toUpper } from 'lodash';
import moment from 'moment';

import ActivityTypes from '../constants/activities';
import { TransferwiseError } from '../graphql/errors';
import models from '../models';
import { ConnectedAccount } from '../models/ConnectedAccount';
import {
  AccessToken,
  BalanceV4,
  BatchGroup,
  CurrencyPair,
  ExchangeRate,
  Profile,
  QuoteV3,
  RecipientAccount,
  TransactionRequirementsType,
  Transfer,
  Webhook,
  WebhookCreateInput,
  WebhookEvent,
} from '../types/transferwise';

import { FEATURE } from './allowed-features';
import logger from './logger';
import { reportErrorToSentry } from './sentry';
import { sleep } from './utils';

const debug = Debug('transferwise');

const axiosClient = axios.create({
  baseURL: config.transferwise.apiUrl,
});

const isProduction = config.env === 'production';

type TransferwiseErrorCodes = 'balance.payment-option-unavailable' | string;

const signString = (data: string) => {
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  sign.end();
  const key = Buffer.from(config.transferwise.privateKey, 'base64').toString('ascii');
  return sign.sign(key, 'base64');
};

const compactRecipientDetails = <T>(object: T): Partial<T> => <Partial<T>>omitBy(object, isNull);

const getData = <T extends { data?: Record<string, unknown> }>(obj: T | undefined): T['data'] | undefined =>
  obj && obj.data;

const parseError = (
  error: AxiosError<{ errorCode?: TransferwiseErrorCodes; errors?: Record<string, unknown>[]; error?: string }>,
  defaultMessage?: string,
  defaultCode?: string,
): string | Error => {
  let message = defaultMessage;
  let code = defaultCode;

  if (error.response?.data?.errorCode) {
    code = `transferwise.error.${error.response.data.errorCode}`;
  }
  if (error.response?.data?.errors) {
    message = error.response.data.errors.map(e => e.message).join(' ');
  } else if (error.response?.data?.error) {
    message = error.response.data.error;
  }
  if (error.response?.status === 422) {
    message = `TransferWise validation error: ${message}`;
    code = `transferwise.error.validation`;
  }

  return new TransferwiseError(message, code, {
    tracing: pick(error.response?.headers, ['x-trace-id', 'cf-ray']),
  });
};

export async function getToken(connectedAccount: ConnectedAccount, refresh = false): Promise<string> {
  // OAuth token, require us to refresh every 12 hours
  const tokenCreation = moment.utc(connectedAccount.data.created_at);
  const diff = moment.duration(moment.utc().diff(tokenCreation)).asSeconds();
  const isOutdated = diff > <number>connectedAccount.data.expires_in - 60;
  if (refresh || isOutdated) {
    const newToken = await getOrRefreshToken({ refreshToken: connectedAccount.refreshToken });
    if (!newToken) {
      models.Activity.create({
        type: ActivityTypes.CONNECTED_ACCOUNT_ERROR,
        data: { connectedAccount: connectedAccount.activity, error: 'There was an error refreshing the Wise token' },
        CollectiveId: connectedAccount.CollectiveId,
      });
      throw new Error('There was an error refreshing the Wise token');
    }
    const { access_token: token, refresh_token: refreshToken, ...data } = newToken;
    await connectedAccount.update({ token, refreshToken, data: { ...connectedAccount.data, ...data } });
    return token;
  } else {
    return connectedAccount.token;
  }
}

export const requestDataAndThrowParsedError = async (
  fn: (url, data?, options?) => Promise<AxiosResponse>,
  url: string,
  {
    data,
    requestPath,
    connectedAccount,
    retries = 0,
    ...options
  }: {
    data?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    params?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    requestPath?: string;
    connectedAccount?: ConnectedAccount;
    retries?: number;
  },
  defaultErrorMessage?: string,
): Promise<any> => {
  const start = process.hrtime.bigint();

  if (connectedAccount) {
    const token = await getToken(connectedAccount);
    set(options, 'headers.Authorization', `Bearer ${token}`);
  }

  debug(
    `calling ${config.transferwise.apiUrl}${url}: ${JSON.stringify(
      { data, params: options.params, retries },
      null,
      2,
    )}`,
  );

  try {
    const pRequest = data ? fn(url, data, options) : fn(url, options);
    const response = await pRequest;
    return getData(response);
  } catch (e: any) {
    const signatureFailed = e?.response?.headers?.['x-2fa-approval-result'] === 'REJECTED';
    const hadSignature = options.headers?.['X-Signature'];
    if (signatureFailed && !hadSignature) {
      const ott = e.response.headers['x-2fa-approval'];
      const signature = signString(ott);
      options.headers = { ...options.headers, 'X-Signature': signature, 'x-2fa-approval': ott };
      return requestDataAndThrowParsedError(
        fn,
        url,
        { data, requestPath, connectedAccount, retries, ...cloneDeep(options) },
        defaultErrorMessage,
      );
    } else if (
      connectedAccount &&
      retries < 4 &&
      e?.response?.status === 401 &&
      e?.response?.data?.['error'] === 'invalid_token'
    ) {
      const delay = retries * 300;
      debug(`invalid_token: waiting ${delay}ms, refreshing the token and trying again (retries: ${retries})...`);
      await sleep(delay);
      await getToken(connectedAccount, true);
      return requestDataAndThrowParsedError(
        fn,
        url,
        { data, requestPath, connectedAccount, retries: retries + 1, ...cloneDeep(options) },
        defaultErrorMessage,
      );
    } else {
      debug(JSON.stringify(e.response?.data, null, 2) || e);
      const error = parseError(e, defaultErrorMessage);
      logger.error(error.toString());
      reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE, requestPath });
      throw error;
    }
  } finally {
    const end = process.hrtime.bigint();
    const executionTime = Math.round(Number(end - start) / 1000000);
    debug(`called ${config.transferwise.apiUrl}${url} in ${executionTime}ms`);
  }
};

interface CreateQuote {
  profileId: number;
  sourceCurrency: string;
  targetCurrency: string;
  targetAccount?: number;
  targetAmount?: number;
  sourceAmount?: number;
  payOut?: 'BANK_TRANSFER' | 'BALANCE' | 'SWIFT' | 'INTERAC' | null;
  paymentMetadata?: QuoteV3['paymentMetadata'];
}
export const createQuote = async (
  connectedAccount: ConnectedAccount,
  {
    profileId: profile,
    sourceCurrency,
    targetCurrency,
    targetAmount,
    sourceAmount,
    payOut,
    targetAccount,
    paymentMetadata,
  }: CreateQuote,
): Promise<QuoteV3> => {
  const data = {
    payOut,
    targetAccount,
    preferredPayIn: 'BALANCE',
    sourceAmount,
    sourceCurrency,
    targetAmount,
    targetCurrency,
    paymentMetadata,
  };
  return requestDataAndThrowParsedError(
    axiosClient.post,
    `/v3/profiles/${profile}/quotes`,
    {
      connectedAccount,
      data,
    },
    'There was an error while creating the quote on Wise',
  );
};

export const createRecipientAccount = async (
  connectedAccount: ConnectedAccount,
  { currency, type, accountHolderName, legalType, details }: RecipientAccount,
): Promise<RecipientAccount> => {
  const profile = connectedAccount.data.id;
  const data = { profile, currency, type, accountHolderName, legalType, details };
  const response = await requestDataAndThrowParsedError(
    axiosClient.post,
    `/v1/accounts`,
    {
      data,
      connectedAccount,
    },
    "There was an error while creating Wise's recipient",
  );
  return {
    ...response,
    details: compactRecipientDetails(response.details),
  };
};

export interface CreateTransfer {
  accountId: number;
  quoteUuid: string;
  customerTransactionId: string;
  details?: {
    reference?: string;
    transferPurpose?: string;
    sourceOfFunds?: string;
    transferNature?: string;
  };
}
export const createTransfer = async (
  connectedAccount: ConnectedAccount,
  { accountId: targetAccount, quoteUuid, customerTransactionId, details }: CreateTransfer,
): Promise<Transfer> => {
  const data = { targetAccount, quoteUuid, customerTransactionId, details };
  return requestDataAndThrowParsedError(
    axiosClient.post,
    `/v1/transfers`,
    {
      data,
      connectedAccount,
    },
    'There was an error while creating the Wise transfer',
  );
};

export const validateTransferRequirements = async (
  connectedAccount: ConnectedAccount,
  { accountId: targetAccount, quoteUuid, details }: Omit<CreateTransfer, 'customerTransactionId'>,
): Promise<TransactionRequirementsType[]> => {
  const data = { targetAccount, quoteUuid, details };
  return requestDataAndThrowParsedError(
    axiosClient.post,
    `/v1/transfer-requirements`,
    {
      data,
      connectedAccount,
    },
    'There was an error while creating the Wise transfer',
  );
};

export const cancelTransfer = async (
  connectedAccount: ConnectedAccount,
  transferId: string | number,
): Promise<Transfer> => {
  return requestDataAndThrowParsedError(
    axiosClient.put,
    `/v1/transfers/${transferId}/cancel`,
    {
      requestPath: '/v1/transfers/:id/cancel',
      data: {},
      connectedAccount,
    },
    'There was an error while cancelling the Wise transfer',
  );
};

interface FundTransfer {
  transferId: number;
}
export const fundTransfer = async (
  connectedAccount: ConnectedAccount,
  { transferId }: FundTransfer,
): Promise<{ status: 'COMPLETED' | 'REJECTED'; errorCode: string }> => {
  const profileId = connectedAccount.data.id;
  return requestDataAndThrowParsedError(
    axiosClient.post,
    `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
    {
      requestPath: '/v3/profiles/:profileId/transfers/:transferId/payments',
      data: { type: 'BALANCE' },
      connectedAccount,
    },
    'There was an error while funding the transfer for Wise',
  );
};

export const getProfiles = async (connectedAccount: ConnectedAccount): Promise<Profile[]> => {
  return requestDataAndThrowParsedError(
    axiosClient.get,
    `/v1/profiles`,
    {
      connectedAccount,
    },
    'There was an error fetching the profiles for Wise',
  );
};

export const listTransfers = async (connectedAccount: ConnectedAccount, params) => {
  return requestDataAndThrowParsedError(
    axiosClient.get,
    `/v1/transfers`,
    {
      connectedAccount,
      params,
    },
    'There was an error fetching transfers from Wise',
  );
};

export const getRecipient = async (connectedAccount: ConnectedAccount, accountId) => {
  return requestDataAndThrowParsedError(
    axiosClient.get,
    `/v1/accounts/${accountId}`,
    {
      connectedAccount,
    },
    'There was an error fetching the recipient information from Wise',
  );
};

interface GetTemporaryQuote {
  sourceCurrency: string;
  targetCurrency: string;
  targetAmount?: number;
  sourceAmount?: number;
}
export const getTemporaryQuote = async (
  connectedAccount: ConnectedAccount,
  { sourceCurrency, targetCurrency, ...amount }: GetTemporaryQuote,
): Promise<QuoteV3> => {
  const data = {
    sourceCurrency,
    targetCurrency,
    ...amount,
  };
  return requestDataAndThrowParsedError(
    axiosClient.post,
    `/v3/quotes`,
    {
      connectedAccount,
      data,
    },
    'There was an error while fetching the Wise quote',
  );
};

export const getTransfer = async (connectedAccount: ConnectedAccount, transferId: number): Promise<Transfer> => {
  return requestDataAndThrowParsedError(
    axiosClient.get,
    `/v1/transfers/${transferId}`,
    {
      requestPath: '/v1/transfers/:id',
      connectedAccount,
    },
    'There was an error fetching transfer for Wise',
  );
};

export const simulateTransferSuccess = async (
  connectedAccount: ConnectedAccount,
  transferId: number,
): Promise<Transfer> => {
  if (isProduction) {
    throw new Error('Simulate transfer success is only available in development');
  }

  let response;
  const statuses = ['processing', 'funds_converted', 'outgoing_payment_sent'];
  for (const status of statuses) {
    response = await requestDataAndThrowParsedError(
      axiosClient.get,
      `/v1/simulation/transfers/${transferId}/${status}`,
      {
        requestPath: `/v1/simulation/transfers/:id/${status}`,
        connectedAccount,
      },
      'Development: There was an error simulating transfer status for Wise',
    );
  }

  return response;
};

export const getAccountRequirements = async (
  connectedAccount: ConnectedAccount,
  { sourceCurrency, targetCurrency, ...amount }: GetTemporaryQuote,
): Promise<Array<TransactionRequirementsType>> => {
  const params = {
    source: sourceCurrency,
    target: targetCurrency,
    ...amount,
  };
  return requestDataAndThrowParsedError(
    axiosClient.get,
    `/v1/account-requirements`,
    {
      connectedAccount,
      headers: { 'Accept-Minor-Version': 1 },
      params,
    },
    'There was an error while fetching account requirements for Wise',
  );
};

export const getExchangeRates = async (
  connectedAccount: ConnectedAccount,
  source: string,
  target: string,
): Promise<Array<ExchangeRate>> => {
  return requestDataAndThrowParsedError(
    axiosClient.get,
    `/v1/rates?source=${source}&target=${target}`,
    { connectedAccount },
    'There was an error while fetching exchange rates from Wise',
  );
};

export const validateAccountRequirements = async (
  connectedAccount: ConnectedAccount,
  { sourceCurrency, targetCurrency, ...amount }: GetTemporaryQuote,
  accountDetails: Record<string, unknown>,
): Promise<Array<TransactionRequirementsType>> => {
  const params = {
    source: sourceCurrency,
    target: targetCurrency,
    ...amount,
  };
  return requestDataAndThrowParsedError(
    axiosClient.post,
    `/v1/account-requirements`,
    {
      data: accountDetails,
      headers: { 'Accept-Minor-Version': 1 },
      connectedAccount,
      params,
    },
    'There was an error while validating account requirements for Wise',
  );
};

export const getCurrencyPairs = async (
  connectedAccount: ConnectedAccount,
): Promise<{ sourceCurrencies: CurrencyPair[] }> => {
  return requestDataAndThrowParsedError(
    axiosClient.get,
    `/v1/currency-pairs`,
    { connectedAccount },
    'There was an error while fetching currency pairs for Wise',
  );
};

export const listBalancesAccount = async (
  connectedAccount: ConnectedAccount,
  types = 'STANDARD',
): Promise<BalanceV4[]> => {
  try {
    return requestDataAndThrowParsedError(
      axiosClient.get,
      `/v4/profiles/${connectedAccount.data.id}/balances?types=${types}`,
      {
        requestPath: '/v4/profiles/:profileId/balances',
        connectedAccount,
      },
    );
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE });
    throw new Error("There was an error while fetching Host's Wise account");
  }
};

export const createBatchGroup = async (
  connectedAccount: ConnectedAccount,
  data: { name: string; sourceCurrency: string },
): Promise<BatchGroup> => {
  const profileId = connectedAccount.data.id;
  try {
    return requestDataAndThrowParsedError(axiosClient.post, `/v3/profiles/${profileId}/batch-groups`, {
      requestPath: '/v3/profiles/:profileId/batch-groups',
      data,
      connectedAccount,
    });
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE });
    throw new Error('There was an error while creating the batch group.');
  }
};

export const getBatchGroup = async (connectedAccount: ConnectedAccount, batchGroupId: string): Promise<BatchGroup> => {
  const profileId = connectedAccount.data.id;
  try {
    return requestDataAndThrowParsedError(axiosClient.get, `/v3/profiles/${profileId}/batch-groups/${batchGroupId}`, {
      requestPath: '/v3/profiles/:profileId/batch-groups/:batchGroupId',
      connectedAccount,
    });
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE });
    throw new Error('There was an error while fetching the batch group.');
  }
};

export const createBatchGroupTransfer = async (
  connectedAccount: ConnectedAccount,
  batchGroupId: string,
  { accountId: targetAccount, quoteUuid, customerTransactionId, details }: CreateTransfer,
): Promise<Transfer> => {
  const profileId = connectedAccount.data.id;
  const data = { targetAccount, quoteUuid, customerTransactionId, details };
  try {
    return requestDataAndThrowParsedError(
      axiosClient.post,
      `/v3/profiles/${profileId}/batch-groups/${batchGroupId}/transfers`,
      {
        requestPath: '/v3/profiles/:profileId/batch-groups/:batchGroupId/transfers',
        data,
        connectedAccount,
      },
    );
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE });
    throw new Error('There was an error while creating the Wise transfer in the batch group');
  }
};

export const completeBatchGroup = async (
  connectedAccount: ConnectedAccount,
  batchGroupId: string,
  version: number,
): Promise<BatchGroup> => {
  const profileId = connectedAccount.data.id;
  try {
    return requestDataAndThrowParsedError(axiosClient.patch, `/v3/profiles/${profileId}/batch-groups/${batchGroupId}`, {
      requestPath: '/v3/profiles/:profileId/batch-groups/:batchGroupId',
      data: { version, status: 'COMPLETED' },
      connectedAccount,
    });
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE });
    throw new Error('There was an error while creating the Wise transfer in the batch group');
  }
};

export const cancelBatchGroup = async (
  connectedAccount: ConnectedAccount,
  batchGroupId: string,
  version: number,
): Promise<BatchGroup> => {
  const profileId = connectedAccount.data.id;
  try {
    return requestDataAndThrowParsedError(axiosClient.patch, `/v3/profiles/${profileId}/batch-groups/${batchGroupId}`, {
      requestPath: '/v3/profiles/:profileId/batch-groups/:batchGroupId',
      data: { version, status: 'CANCELLED' },
      connectedAccount,
    });
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE });
    throw new Error('There was an error while creating the Wise transfer in the batch group');
  }
};

export type OTTResponse = {
  status: number;
  headers: {
    'x-2fa-approval': string;
  };
};

export const fundBatchGroup = async (
  token: string,
  profileId: string | number,
  batchGroupId: string,
  x2faApproval?: string,
): Promise<BatchGroup | OTTResponse> => {
  const headers = { Authorization: `Bearer ${token}` };
  if (x2faApproval) {
    headers['x-2fa-approval'] = x2faApproval;
  }

  return axiosClient
    .post(`/v3/profiles/${profileId}/batch-payments/${batchGroupId}/payments`, { type: 'BALANCE' }, { headers })
    .then(getData)
    .catch(e => {
      const headers = pick(e.response?.headers, ['x-2fa-approval']);
      const status = e.response?.status;

      if (status === 403 && headers['x-2fa-approval']) {
        return { headers, status };
      } else {
        const error = parseError(e, 'There was an error while funding the batch group');
        logger.error(error);
        reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE });
        throw error;
      }
    });
};

const publicKey = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    'keys',
    isProduction ? 'transferwise.webhook.live.pub' : 'transferwise.webhook.sandbox.pub',
  ),
  { encoding: 'utf-8' },
);

export const verifyEvent = (req: Request & { rawBody: string }): WebhookEvent => {
  const signature = req.headers['x-signature'] as string;
  const sig = crypto.createVerify('RSA-SHA1');
  sig.update(req.rawBody);
  const verified = sig.verify(publicKey, signature, 'base64');
  if (!verified) {
    throw new Error('Could not verify event signature');
  }
  return req.body;
};

export const formatAccountDetails = (payoutMethodData: Record<string, unknown>): string => {
  const ignoredKeys = ['type', 'isManualBankTransfer', 'currency'];
  const labels = {
    abartn: 'Routing Number',
  };

  const formatKey = (s: string): string => {
    if (labels[s]) {
      return labels[s];
    }
    if (toUpper(s) === s) {
      return s;
    }
    return startCase(s);
  };

  const renderObject = (object: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(object).reduce((acc, [key, value]) => {
      if (ignoredKeys.includes(key)) {
        return acc;
      }
      if (typeof value === 'object') {
        return [...acc, formatKey(key), ...renderObject(<Record<string, unknown>>value, '  ')];
      }
      return [...acc, `${prefix}${formatKey(key)}: ${value}`];
    }, []);

  const { accountHolderName, currency, ...data } = payoutMethodData;
  const lines = renderObject({ accountHolderName, currency, ...data });
  return lines.join('\n');
};

export const getOAuthUrl = (state: string): string => {
  return `${config.transferwise.oauthUrl}/oauth/authorize/?client_id=${config.transferwise.clientId}&redirect_uri=${config.transferwise.redirectUri}&state=${state}`;
};

export const getOrRefreshToken = async ({
  code,
  refreshToken,
  application,
}: {
  code?: string;
  refreshToken?: string;
  application?: boolean;
}): Promise<AccessToken> => {
  let data;
  // Refresh Token
  if (refreshToken) {
    data = { grant_type: 'refresh_token', refresh_token: refreshToken };
  }
  // Request user token
  else if (code) {
    data = {
      grant_type: 'authorization_code',
      client_id: config.transferwise.clientId,
      code,
      redirect_uri: config.transferwise.redirectUri,
    };
  }
  // Request application token
  else if (application) {
    data = { grant_type: 'client_credentials' };
  } else {
    return;
  }

  const params = new url.URLSearchParams(data);
  try {
    const token: AccessToken = await axiosClient
      .post(`/oauth/token`, params.toString(), {
        auth: { username: config.transferwise.clientId, password: config.transferwise.clientSecret },
      })
      .then(getData);

    debug(`getOrRefreshUserToken: ${JSON.stringify(token, null, 2)}`);
    return token;
  } catch (e) {
    debug(JSON.stringify(e));
    const error = parseError(e, "There was an error while refreshing host's Wise token");
    logger.error(error.toString());
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE });
    throw error;
  }
};

export const listApplicationWebhooks = async (): Promise<Webhook[]> => {
  const { access_token } = await getOrRefreshToken({ application: true });

  try {
    const webhooks = await axiosClient
      .get(`/v3/applications/${config.transferwise.clientKey}/subscriptions`, {
        headers: { Authorization: `Bearer ${access_token}` },
      })
      .then(getData);
    return webhooks;
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE, requestPath: '/v3/applications/:key/subscriptions' });
    throw new Error("There was an error while listing Wise's application webhooks");
  }
};

export const createApplicationWebhook = async (webhookInfo: WebhookCreateInput): Promise<Webhook> => {
  const { access_token } = await getOrRefreshToken({ application: true });
  debug(`createApplicationWebhook: ${JSON.stringify(webhookInfo, null, 2)}`);
  try {
    const webhook: Webhook = await axiosClient
      .post(`/v3/applications/${config.transferwise.clientKey}/subscriptions`, webhookInfo, {
        headers: { Authorization: `Bearer ${access_token}` },
      })
      .then(getData);
    return webhook;
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE, requestPath: '/v3/applications/:key/subscriptions' });
    throw new Error("There was an error while creating Wise's application webhook");
  }
};

export const deleteApplicationWebhook = async (id: string | number): Promise<any> => {
  const { access_token } = await getOrRefreshToken({ application: true });
  debug(`deleteApplicationWebhook: id ${id}`);
  try {
    return await axiosClient
      .delete(`/v3/applications/${config.transferwise.clientKey}/subscriptions/${id}`, {
        headers: { Authorization: `Bearer ${access_token}` },
      })
      .then(getData);
  } catch (e) {
    logger.error(e);
    reportErrorToSentry(e, { feature: FEATURE.TRANSFERWISE, requestPath: '/v3/applications/:key/subscriptions/:id' });
    throw new Error("There was an error while deleting Wise's application webhook");
  }
};
