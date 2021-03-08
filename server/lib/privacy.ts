/* eslint-disable camelcase */

import Axios from 'axios';
import config from 'config';
import Debug from 'debug';

import { Card, PagingParams, PrivacyResponse, Transaction } from '../types/privacy';

const debug = Debug('privacy');
const axios = Axios.create({
  baseURL: config.privacy.apiUrl,
});

export const listTransactions = async (
  token: string,
  card_token?: string,
  paging?: PagingParams,
  status: 'all' | 'approvals' | 'declines' = 'all',
): Promise<PrivacyResponse<Transaction[]>> => {
  const url = `/v1/transaction/${status}`;
  debug(`${url}: ${card_token}`);

  const response = await axios.get(url, {
    headers: { Authorization: `api-key ${token}` },
    params: { card_token, ...paging },
  });

  return response.data;
};

export const listCards = async (token: string, paging?: PagingParams): Promise<PrivacyResponse<Card[]>> => {
  const url = `/v1/card`;
  debug(`${url}`);

  const response = await axios.get(url, {
    headers: { Authorization: `api-key ${token}` },
    params: paging,
  });

  return response.data;
};
