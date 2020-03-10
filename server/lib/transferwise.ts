import Axios, { AxiosError } from 'axios';
import config from 'config';
import crypto from 'crypto';
import { Request } from 'express';
import fs from 'fs';
import { omitBy, isNull, toInteger } from 'lodash';
import path from 'path';
import url from 'url';

import logger from './logger';
import {
  BorderlessAccount,
  CurrencyPair,
  Profile,
  Quote,
  RecipientAccount,
  Transfer,
  WebhookEvent,
} from '../types/transferwise';

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

const getErrorCode = (error: AxiosError): string => {
  if (error.response?.data?.errorCode) {
    return error.response.data.errorCode;
  } else if (error.response?.status) {
    // The request was made and the server responded with a status code
    // that falls out of the range of 2xx
    return `${error.response.status}: ${JSON.stringify(error.response.data)}`;
  } else {
    return error.toString();
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
  try {
    const response = await axios.post(`/v1/quotes`, data, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    logger.error(`Unable to create quote: ${getErrorCode(e)}`, data);
    throw new Error(`Sorry, we can't make transfers to ${targetCurrency}.`);
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
    const message = `Unable to create recipient account: ${getErrorCode(e)}`;
    logger.error(message);
    throw new Error(message);
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
    const message = `Unable to create transfer: ${getErrorCode(e)}`;
    logger.error(message);
    throw new Error(message);
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
    const message = `Unable to cancel transfer: ${getErrorCode(e)}`;
    logger.error(message);
    throw new Error(message);
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
    const message = `Unable to fund transfer: ${getErrorCode(e)}`;
    logger.error(message, { transferId });
    throw new Error(message);
  }
};

export const getProfiles = async (token: string): Promise<Profile[]> => {
  try {
    const response = await axios.get(`/v1/profiles`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    const message = `Unable to get profiles: ${getErrorCode(e)}`;
    logger.error(message);
    throw new Error(message);
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
    logger.error(`Unable to get temporary quote: ${getErrorCode(e)}`, params);
    throw new Error('An unknown error happened with Transferwise. Please contact support@opencollective.com.');
  }
};

export const getTransfer = async (token: string, transferId: number): Promise<Transfer> => {
  try {
    const response = await axios.get(`/v1/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    logger.error(`Unable to get transfer data: ${getErrorCode(e)}`, { transferId });
    throw new Error('An unknown error happened with Transferwise. Please contact support@opencollective.com.');
  }
};

export const getAccountRequirements = async (token: string, quoteId: number): Promise<any> => {
  try {
    const response = await axios.get(`/v1/quotes/${quoteId}/account-requirements`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    logger.error(`Unable to get account requirements data: ${getErrorCode(e)}`, { quoteId });
    throw new Error('An unknown error happened with Transferwise. Please contact support@opencollective.com.');
  }
};

export const getCurrencyPairs = async (token: string): Promise<{ sourceCurrencies: CurrencyPair[] }> => {
  try {
    const response = await axios.get(`/v1/currency-pairs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return getData(response);
  } catch (e) {
    logger.error(`Unable to get currency pairs data: ${getErrorCode(e)}`);
    throw new Error('An unknown error happened with Transferwise. Please contact support@opencollective.com.');
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
    logger.error(`Unable to get balances: ${getErrorCode(e)}`);
    throw new Error('An unknown error happened with Transferwise. Please contact support@opencollective.com.');
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
