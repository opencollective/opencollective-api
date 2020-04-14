import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';

import Axios, { AxiosError } from 'axios';
import config from 'config';
import { Request } from 'express';
import { isNull, omitBy, toInteger } from 'lodash';

import {
  BorderlessAccount,
  CurrencyPair,
  Profile,
  Quote,
  RecipientAccount,
  Transfer,
  WebhookEvent,
} from '../types/transferwise';
import { TransferwiseError } from '../graphql/errors';

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

const compactRecipientDetails = <T>(object: T): Partial<T> => omitBy(object, isNull);
const getData = <T extends { data?: object }>(obj: T | undefined): T['data'] | undefined => obj && obj.data;

type TransferwiseErrorCodes = 'balance.payment-option-unavailable' | string;

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
  try {
    const response = await axios.post(`/v1/quotes`, data, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString(), data);
    throw error;
  }
};

interface CreateRecipientAccount extends RecipientAccount {
  profileId: number;
}
export const createRecipientAccount = async (
  token: string,
  { profileId: profile, currency, type, accountHolderName, legalType, details }: CreateRecipientAccount,
): Promise<RecipientAccount> => {
  const data = { profile, currency, type, accountHolderName, legalType, details };
  try {
    const response = await axios.post(`/v1/accounts`, data, {
      headers: { Authorization: `Bearer ${token}` },
    });

    return {
      ...response.data,
      details: compactRecipientDetails(response.data.details),
    };
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString(), data);
    throw error;
  }
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
  try {
    const response = await axios.post(`/v1/transfers`, data, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString(), data);
    throw error;
  }
};

export const cancelTransfer = async (token: string, transferId: string | number): Promise<Transfer> => {
  try {
    const response = await axios.put(
      `/v1/transfers/${transferId}/cancel`,
      {},
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    return getData(response);
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString());
    throw error;
  }
};

interface FundTransfer {
  profileId: number;
  transferId: number;
}
export const fundTransfer = async (
  token,
  { profileId, transferId }: FundTransfer,
): Promise<{ status: 'COMPLETED' | 'REJECTED'; errorCode: string }> => {
  try {
    const response = await axios.post(
      `/v3/profiles/${profileId}/transfers/${transferId}/payments`,
      { type: 'BALANCE' },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return getData(response);
  } catch (e) {
    const error = parseError(e, 'Unable to fund transfer, please check your balance and try again.');
    logger.error(error.toString());
    throw error;
  }
};

export const getProfiles = async (token: string): Promise<Profile[]> => {
  try {
    const response = await axios.get(`/v1/profiles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    const error = parseError(e, 'Unable to fetch profiles.');
    logger.error(error.toString());
    throw error;
  }
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
  try {
    const response = await axios.get(`/v1/quotes`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });
    return getData(response);
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString());
    throw error;
  }
};

export const getTransfer = async (token: string, transferId: number): Promise<Transfer> => {
  try {
    const response = await axios.get(`/v1/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString(), { transferId });
    throw error;
  }
};

export const getAccountRequirements = async (token: string, quoteId: number): Promise<any> => {
  try {
    const response = await axios.get(`/v1/quotes/${quoteId}/account-requirements`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString());
    throw error;
  }
};

export const getCurrencyPairs = async (token: string): Promise<{ sourceCurrencies: CurrencyPair[] }> => {
  try {
    const response = await axios.get(`/v1/currency-pairs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString());
    throw error;
  }
};

export const getBorderlessAccount = async (token: string, profileId: string | number): Promise<BorderlessAccount> => {
  try {
    const response = await axios.get(`/v1/borderless-accounts?profileId=${profileId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const accounts: BorderlessAccount[] = getData(response);
    return accounts.find(a => a.profileId === profileId);
  } catch (e) {
    const error = parseError(e);
    logger.error(error.toString());
    throw error;
  }
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
