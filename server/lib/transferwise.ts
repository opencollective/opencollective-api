/* eslint-disable camelcase */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';

import Axios, { AxiosError } from 'axios';
import config from 'config';
import Debug from 'debug';
import { Request } from 'express';
import { isNull, omitBy, pick, startCase, toInteger, toUpper } from 'lodash';

import { TransferwiseError } from '../graphql/errors';
import {
  AccessToken,
  BatchGroup,
  BorderlessAccount,
  CurrencyPair,
  Profile,
  QuoteV2,
  RecipientAccount,
  Transfer,
  Webhook,
  WebhookCreateInput,
  WebhookEvent,
} from '../types/transferwise';

import logger from './logger';

const debug = Debug('transferwise');
const fixieUrl = config.fixie.url && new url.URL(config.fixie.url);
const proxyOptions = fixieUrl
  ? {
      proxy: {
        host: fixieUrl.host,
        port: toInteger(fixieUrl.port),
      },
      headers: {
        'Proxy-Authorization': `Basic ${Buffer.from(`${fixieUrl.username}:${fixieUrl.password}`).toString('base64')}`,
      },
    }
  : {};
const axios = Axios.create({
  baseURL: config.transferwise.apiUrl,
  ...proxyOptions,
});

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

const tap = fn => data => {
  fn(data);
  return data;
};

const parseError = (
  error: AxiosError<{ errorCode?: TransferwiseErrorCodes; errors?: Record<string, unknown>[] }>,
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
  }
  if (error.response?.status === 422) {
    message = `TransferWise validation error: ${message}`;
    code = `transferwise.error.validation`;
  }

  return new TransferwiseError(message, code);
};

export const requestDataAndThrowParsedError = (
  fn: Function,
  url: string,
  {
    data,
    ...options
  }: {
    data?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    params?: Record<string, unknown>;
    auth?: Record<string, unknown>;
  },
  defaultErrorMessage?: string,
): Promise<any> => {
  const start = process.hrtime.bigint();
  debug(`calling ${config.transferwise.apiUrl}${url}: ${JSON.stringify({ data, params: options.params }, null, 2)}`);
  const pRequest = data ? fn(url, data, options) : fn(url, options);
  return pRequest
    .then(getData)
    .then(tap(data => debug(JSON.stringify(data, null, 2))))
    .catch(e => {
      // Implements Strong Customer Authentication
      // https://api-docs.transferwise.com/#payouts-guide-strong-customer-authentication
      const signatureFailed = e?.response?.headers['x-2fa-approval-result'] === 'REJECTED';
      const hadSignature = e?.response?.headers['X-Signature'];
      if (signatureFailed && !hadSignature) {
        const ott = e.response.headers['x-2fa-approval'];
        const signature = signString(ott);
        options.headers = { ...options.headers, 'X-Signature': signature, 'x-2fa-approval': ott };
        const request = data ? fn(url, data, options) : fn(url, options);
        return request.then(getData);
      } else {
        throw e;
      }
    })
    .catch(e => {
      debug(JSON.stringify(e.response?.data, null, 2) || e);
      const error = parseError(e, defaultErrorMessage);
      logger.error(error.toString());
      throw error;
    })
    .finally(() => {
      const end = process.hrtime.bigint();
      const executionTime = Math.round(Number(end - start) / 1000000);
      debug(`called ${config.transferwise.apiUrl}${url} in ${executionTime}ms`);
    });
};

interface CreateQuote {
  profileId: number;
  sourceCurrency: string;
  targetCurrency: string;
  targetAccount?: number;
  targetAmount?: number;
  sourceAmount?: number;
  payOut?: 'BANK_TRANSFER' | 'BALANCE' | 'SWIFT' | 'INTERAC' | null;
}
export const createQuote = async (
  token: string,
  {
    profileId: profile,
    sourceCurrency,
    targetCurrency,
    targetAmount,
    sourceAmount,
    payOut,
    targetAccount,
  }: CreateQuote,
): Promise<QuoteV2> => {
  const data = {
    payOut,
    profile,
    sourceAmount,
    sourceCurrency,
    targetAccount,
    targetAmount,
    targetCurrency,
  };
  return requestDataAndThrowParsedError(
    axios.post,
    `/v2/quotes`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data,
    },
    'There was an error while creating the quote on Wise',
  );
};

interface CreateRecipientAccount extends RecipientAccount {
  profileId: number;
}
export const createRecipientAccount = async (
  token: string,
  { profileId: profile, currency, type, accountHolderName, legalType, details }: CreateRecipientAccount,
): Promise<RecipientAccount> => {
  const data = { profile, currency, type, accountHolderName, legalType, details };
  const response = await requestDataAndThrowParsedError(
    axios.post,
    `/v1/accounts`,
    {
      data,
      headers: { Authorization: `Bearer ${token}` },
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
  };
}
export const createTransfer = async (
  token: string,
  { accountId: targetAccount, quoteUuid, customerTransactionId, details }: CreateTransfer,
): Promise<Transfer> => {
  const data = { targetAccount, quoteUuid, customerTransactionId, details };
  return requestDataAndThrowParsedError(
    axios.post,
    `/v1/transfers`,
    {
      data,
      headers: { Authorization: `Bearer ${token}` },
    },
    'There was an error while creating the Wise transfer',
  );
};

export const cancelTransfer = async (token: string, transferId: string | number): Promise<Transfer> => {
  return requestDataAndThrowParsedError(
    axios.put,
    `/v1/transfers/${transferId}/cancel`,
    {
      data: {},
      headers: { Authorization: `Bearer ${token}` },
    },
    'There was an error while cancelling the Wise transfer',
  );
};

interface FundTransfer {
  profileId: number;
  transferId: number;
}
export const fundTransfer = async (
  token: string,
  { profileId, transferId }: FundTransfer,
): Promise<{ status: 'COMPLETED' | 'REJECTED'; errorCode: string }> => {
  return requestDataAndThrowParsedError(
    axios.post,
    `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
    {
      data: { type: 'BALANCE' },
      headers: { Authorization: `Bearer ${token}` },
    },
    'There was an error while funding the transfer for Wise',
  );
};

export const getProfiles = async (token: string): Promise<Profile[]> => {
  return requestDataAndThrowParsedError(
    axios.get,
    `/v1/profiles`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
    'There was an error fetching the profiles for Wise',
  );
};

interface GetTemporaryQuote {
  sourceCurrency: string;
  targetCurrency: string;
  targetAmount?: number;
  sourceAmount?: number;
}
export const getTemporaryQuote = async (
  token: string,
  { sourceCurrency, targetCurrency, ...amount }: GetTemporaryQuote,
): Promise<QuoteV2> => {
  const data = {
    sourceCurrency,
    targetCurrency,
    ...amount,
  };
  return requestDataAndThrowParsedError(
    axios.post,
    `/v2/quotes`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data,
    },
    'There was an error while fetching the Wise quote',
  );
};

export const getTransfer = async (token: string, transferId: number): Promise<Transfer> => {
  return requestDataAndThrowParsedError(
    axios.get,
    `/v1/transfers/${transferId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
    'There was an error fetching transfer for Wise',
  );
};

export const getAccountRequirements = async (
  token: string,
  { sourceCurrency, targetCurrency, ...amount }: GetTemporaryQuote,
): Promise<any> => {
  const params = {
    source: sourceCurrency,
    target: targetCurrency,
    ...amount,
  };
  return requestDataAndThrowParsedError(
    axios.get,
    `/v1/account-requirements`,
    {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Minor-Version': 1 },
      params,
    },
    'There was an error while fetching account requirements for Wise',
  );
};

export const validateAccountRequirements = async (
  token: string,
  { sourceCurrency, targetCurrency, ...amount }: GetTemporaryQuote,
  accountDetails: Record<string, unknown>,
): Promise<any> => {
  const params = {
    source: sourceCurrency,
    target: targetCurrency,
    ...amount,
  };
  return requestDataAndThrowParsedError(
    axios.post,
    `/v1/account-requirements`,
    {
      data: accountDetails,
      headers: { Authorization: `Bearer ${token}`, 'Accept-Minor-Version': 1 },
      params,
    },
    'There was an error while validating account requirements for Wise',
  );
};

export const getCurrencyPairs = async (token: string): Promise<{ sourceCurrencies: CurrencyPair[] }> => {
  return requestDataAndThrowParsedError(
    axios.get,
    `/v1/currency-pairs`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
    'There was an error while fetching account requirements for Wise',
  );
};

export const getBorderlessAccount = async (token: string, profileId: string | number): Promise<BorderlessAccount> => {
  try {
    const accounts: BorderlessAccount[] = await requestDataAndThrowParsedError(
      axios.get,
      `/v1/borderless-accounts?profileId=${profileId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return accounts.find(a => a.profileId === profileId);
  } catch (e) {
    logger.error(e);
    throw new Error("There was an error while fetching Host's Wise account");
  }
};

export const createBatchGroup = async (
  token: string,
  profileId: string | number,
  data: { name: string; sourceCurrency: string },
): Promise<BatchGroup> => {
  try {
    return requestDataAndThrowParsedError(axios.post, `/v3/profiles/${profileId}/batch-groups`, {
      headers: { Authorization: `Bearer ${token}` },
      data,
    });
  } catch (e) {
    logger.error(e);
    throw new Error('There was an error while creating the batch group.');
  }
};

export const getBatchGroup = async (
  token: string,
  profileId: string | number,
  batchGroupId: string,
): Promise<BatchGroup> => {
  try {
    return requestDataAndThrowParsedError(axios.get, `/v3/profiles/${profileId}/batch-groups/${batchGroupId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    logger.error(e);
    throw new Error('There was an error while fetching the batch group.');
  }
};

export const createBatchGroupTransfer = async (
  token: string,
  profileId: string | number,
  batchGroupId: string,
  { accountId: targetAccount, quoteUuid, customerTransactionId, details }: CreateTransfer,
): Promise<Transfer> => {
  const data = { targetAccount, quoteUuid, customerTransactionId, details };
  try {
    return requestDataAndThrowParsedError(
      axios.post,
      `/v3/profiles/${profileId}/batch-groups/${batchGroupId}/transfers`,
      {
        data,
        headers: { Authorization: `Bearer ${token}` },
      },
    );
  } catch (e) {
    logger.error(e);
    throw new Error('There was an error while creating the Wise transfer in the batch group');
  }
};

export const completeBatchGroup = async (
  token: string,
  profileId: string | number,
  batchGroupId: string,
  version: number,
): Promise<BatchGroup> => {
  try {
    return requestDataAndThrowParsedError(axios.patch, `/v3/profiles/${profileId}/batch-groups/${batchGroupId}`, {
      data: { version, status: 'COMPLETED' },
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    logger.error(e);
    throw new Error('There was an error while creating the Wise transfer in the batch group');
  }
};

export const cancelBatchGroup = async (
  token: string,
  profileId: string | number,
  batchGroupId: string,
  version: number,
): Promise<BatchGroup> => {
  try {
    return requestDataAndThrowParsedError(axios.patch, `/v3/profiles/${profileId}/batch-groups/${batchGroupId}`, {
      data: { version, status: 'CANCELLED' },
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    logger.error(e);
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

  return axios
    .post(`/v3/profiles/${profileId}/batch-payments/${batchGroupId}/payments`, { type: 'BALANCE' }, { headers })
    .then(getData)
    .catch(e => {
      const headers = pick(e.response?.headers, ['x-2fa-approval']);
      const status = e.response?.status;

      if (status === 403 && headers['x-2fa-approval']) {
        return { headers, status };
      } else {
        logger.error(e);
        throw new Error('There was an error while funding the batch group');
      }
    });
};

const isProduction = config.env === 'production';

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
    const token: AccessToken = await axios
      .post(`/oauth/token`, params.toString(), {
        auth: { username: config.transferwise.clientId, password: config.transferwise.clientSecret },
      })
      .then(getData);

    debug(`getOrRefreshUserToken: ${JSON.stringify(token, null, 2)}`);
    return token;
  } catch (e) {
    const error = parseError(e, "There was an error while refreshing host's Wise token");
    logger.error(error.toString());
    throw error;
  }
};

export const listApplicationWebhooks = async (): Promise<Webhook[]> => {
  const { access_token } = await getOrRefreshToken({ application: true });

  try {
    const webhooks = await axios
      .get(`/v3/applications/${config.transferwise.clientKey}/subscriptions`, {
        headers: { Authorization: `Bearer ${access_token}` },
      })
      .then(getData);
    return webhooks;
  } catch (e) {
    logger.error(e);
    throw new Error("There was an error while listing Wise's application webhooks");
  }
};

export const createApplicationWebhook = async (webhookInfo: WebhookCreateInput): Promise<Webhook> => {
  const { access_token } = await getOrRefreshToken({ application: true });
  debug(`createApplicationWebhook: ${JSON.stringify(webhookInfo, null, 2)}`);
  try {
    const webhook: Webhook = await axios
      .post(`/v3/applications/${config.transferwise.clientKey}/subscriptions`, webhookInfo, {
        headers: { Authorization: `Bearer ${access_token}` },
      })
      .then(getData);
    return webhook;
  } catch (e) {
    logger.error(e);
    throw new Error("There was an error while creating Wise's application webhook");
  }
};

export const deleteApplicationWebhook = async (id: string | number): Promise<any> => {
  const { access_token } = await getOrRefreshToken({ application: true });
  debug(`deleteApplicationWebhook: id ${id}`);
  try {
    return await axios
      .delete(`/v3/applications/${config.transferwise.clientKey}/subscriptions/${id}`, {
        headers: { Authorization: `Bearer ${access_token}` },
      })
      .then(getData);
  } catch (e) {
    logger.error(e);
    throw new Error("There was an error while deleting Wise's application webhook");
  }
};
