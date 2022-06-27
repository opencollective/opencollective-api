/* eslint-disable camelcase */

import crypto from 'crypto';

import Axios from 'axios';
import config from 'config';
import Debug from 'debug';
import { find, pick } from 'lodash';

import { Card, PagingParams, PrivacyResponse, Transaction } from '../types/privacy';

const debug = Debug('privacy');
const axios = Axios.create({
  baseURL: config.privacy.apiUrl,
});

const sanitizeError = e => {
  e.config = pick(e.config, ['url', 'method', 'params', 'data', 'baseUrl']);
  return e;
};

const rethrowSanitizedError = e => {
  throw sanitizeError(e);
};

export const listTransactions = async (
  token: string,
  card_token?: string,
  paging?: PagingParams,
  status: 'all' | 'approvals' | 'declines' = 'all',
): Promise<PrivacyResponse<Transaction[]>> => {
  const url = `/v1/transaction/${status}`;
  debug(`GET ${url}: ${card_token}`);

  const response = await axios
    .get(url, {
      headers: { Authorization: `api-key ${token}` },
      params: { card_token, ...paging },
    })
    .catch(rethrowSanitizedError);

  return response.data;
};

export const listCards = async (token: string, card_token?: string, paging?: PagingParams): Promise<Card[]> => {
  const url = `/v1/card`;
  debug(`GET ${url}`);

  const response = await axios
    .get(url, {
      headers: { Authorization: `api-key ${token}` },
      params: { ...paging, card_token },
    })
    .catch(rethrowSanitizedError);

  return response.data?.data;
};

export const findCard = async (token: string, cardProperties: Partial<Card>): Promise<Card> => {
  debug(`Searching for card ${JSON.stringify(cardProperties)}`);
  let page = 1;
  let keepGoing = true;
  while (keepGoing) {
    const cards = await listCards(token, undefined, { page, page_size: 500 });
    debug(`got page ${page} with ${cards.length} cards...`);
    if (cards.length === 0) {
      return undefined;
    }
    const card = find(cards, cardProperties);
    if (card) {
      keepGoing = false;
      return card;
    }
    page++;
  }
};

export const updateCard = async (
  token: string,
  cardProperties: Partial<Card> | { card_token: string },
): Promise<Card> => {
  const url = `/v1/card`;
  debug(`PUT ${url}`);

  const response = await axios
    .put(url, cardProperties, {
      headers: { Authorization: `api-key ${token}` },
    })
    .catch(rethrowSanitizedError);

  return response.data;
};

export const verifyEvent = (signature: string, rawBody: string, key: string) => {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(rawBody);
  const verified = signature === hmac.digest('base64');

  if (!verified) {
    throw new Error('Could not verify event signature');
  }
};
