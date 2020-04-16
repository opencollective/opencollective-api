import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';

import Axios, { AxiosError } from 'axios';
import config from 'config';
import { Request } from 'express';
import { isNull, omitBy, toInteger } from 'lodash';

import { TransferwiseError } from '../graphql/errors';
import {
  BorderlessAccount,
  CurrencyPair,
  Profile,
  Quote,
  RecipientAccount,
  Transfer,
  WebhookEvent,
} from '../types/transferwise';

import logger from './logger';

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

const compactRecipientDetails = <T>(object: T): Partial<T> => omitBy(object, isNull);
const getData = <T extends { data?: object }>(obj: T | undefined): T['data'] | undefined => obj && obj.data;
const parseError = (
  error: AxiosError<{ errorCode?: TransferwiseErrorCodes }>,
  defaultMessage?: string,
  defaultCode?: string,
): string | Error => {
  return new TransferwiseError(
    defaultMessage,
    error.response?.data?.errorCode ? `transferwise.error.${error.response.data.errorCode}` : defaultCode,
  );
};
const requestDataAndThrowParsedError = async (request: Promise<any>, defaultErrorMessage?: string): Promise<any> => {
  try {
    const response = await request;
    return getData(response);
  } catch (e) {
    const error = parseError(e, defaultErrorMessage);
    logger.error(error.toString());
    throw error;
  }
};

interface CreateQuote {
  profileId: number;
  sourceCurrency: string;
  targetCurrency: string;
  targetAmount?: number;
  sourceAmount?: number;
}
export const createQuote = async (
  token: string,
  { profileId: profile, sourceCurrency, targetCurrency, targetAmount, sourceAmount }: CreateQuote,
): Promise<Quote> => {
  const data = {
    profile,
    source: sourceCurrency,
    target: targetCurrency,
    rateType: 'FIXED',
    type: 'BALANCE_PAYOUT',
    targetAmount,
    sourceAmount,
  };
  return requestDataAndThrowParsedError(
    axios.post(`/v1/quotes`, data, {
      headers: { Authorization: `Bearer ${token}` },
    }),
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
    axios.post(`/v1/accounts`, data, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  return {
    ...response,
    details: compactRecipientDetails(response.details),
  };
};

interface CreateTransfer {
  accountId: number;
  quoteId: number;
  uuid: string;
  details?: {
    reference?: string;
    transferPurpose?: string;
    sourceOfFunds?: string;
  };
}
export const createTransfer = async (
  token: string,
  { accountId: targetAccount, quoteId: quote, uuid: customerTransactionId, details }: CreateTransfer,
): Promise<Transfer> => {
  const data = { targetAccount, quote, customerTransactionId, details };
  return requestDataAndThrowParsedError(
    axios.post(`/v1/transfers`, data, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
};

export const cancelTransfer = async (token: string, transferId: string | number): Promise<Transfer> => {
  return requestDataAndThrowParsedError(
    axios.put(
      `/v1/transfers/${transferId}/cancel`,
      {},
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  );
};

interface FundTransfer {
  profileId: number;
  transferId: number;
}
export const fundTransfer = async (
  token,
  { profileId, transferId }: FundTransfer,
): Promise<{ status: 'COMPLETED' | 'REJECTED'; errorCode: string }> => {
  return requestDataAndThrowParsedError(
    axios.post(
      `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
      { type: 'BALANCE' },
      { headers: { Authorization: `Bearer ${token}` } },
    ),
    'Unable to fund transfer, please check your balance and try again.',
  );
};

export const getProfiles = async (token: string): Promise<Profile[]> => {
  return requestDataAndThrowParsedError(
    axios.get(`/v1/profiles`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    'Unable to fetch profiles.',
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
): Promise<Quote> => {
  const params = {
    source: sourceCurrency,
    target: targetCurrency,
    rateType: 'FIXED',
    ...amount,
  };
  return requestDataAndThrowParsedError(
    axios.get(`/v1/quotes`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    }),
  );
};

export const getTransfer = async (token: string, transferId: number): Promise<Transfer> => {
  return requestDataAndThrowParsedError(
    axios.get(`/v1/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
};

export const getAccountRequirements = async (token: string, quoteId: number): Promise<any> => {
  return requestDataAndThrowParsedError(
    axios.get(`/v1/quotes/${quoteId}/account-requirements`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
};

export const getCurrencyPairs = async (token: string): Promise<{ sourceCurrencies: CurrencyPair[] }> => {
  return requestDataAndThrowParsedError(
    axios.get(`/v1/currency-pairs`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
};

export const getBorderlessAccount = async (token: string, profileId: string | number): Promise<BorderlessAccount> => {
  const accounts: BorderlessAccount[] = await requestDataAndThrowParsedError(
    axios.get(`/v1/borderless-accounts?profileId=${profileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  return accounts.find(a => a.profileId === profileId);
};

const isProduction = process.env.NODE_ENV === 'production';
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
