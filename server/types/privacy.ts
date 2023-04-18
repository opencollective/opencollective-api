/* eslint-disable camelcase */

import { VirtualCardLimitIntervals } from '../constants/virtual-cards';

export type PagingParams = {
  page?: number;
  page_size?: number;
  begin?: Date;
  end?: Date;
};

export type PrivacyResponse<T> = {
  data: T;
  page: number;
  total_entries: number;
  total_pages: number;
};

export type Funding = {
  account_name: string;
  // ISOString
  created: string;
  last_four: string;
  nickname: string;
  state: string;
  token: string;
  type: string;
};

export type Card = {
  funding: Funding;
  // ISOString
  created: string;
  hostname: string;
  last_four: string;
  memo: string;
  spend_limit: number;
  token: string;
  spend_limit_duration: PrivacyVirtualCardLimitInterval;
  state: 'OPEN' | 'PAUSED' | 'CLOSED' | 'PENDING_FULFILLMENT' | 'PENDING_ACTIVATION';
  type: 'SINGLE_USE' | 'MERCHANT_LOCKED' | 'UNLOCKED' | 'PHYSICAL';
  cvv?: string;
  pan?: string;
  exp_year?: string;
  exp_month?: string;
};

export enum PrivacyVirtualCardLimitInterval {
  TRANSACTION = 'TRANSACTION',
  MONTHLY = 'MONTHLY',
  ANNUALLY = 'ANNUALLY',
  FOREVER = 'FOREVER',
}

export const PrivacyVirtualCardLimitIntervalToOCInterval: {
  [privacyInterval in PrivacyVirtualCardLimitInterval]: VirtualCardLimitIntervals;
} = {
  [PrivacyVirtualCardLimitInterval.TRANSACTION]: VirtualCardLimitIntervals.PER_AUTHORIZATION,
  [PrivacyVirtualCardLimitInterval.MONTHLY]: VirtualCardLimitIntervals.MONTHLY,
  [PrivacyVirtualCardLimitInterval.ANNUALLY]: VirtualCardLimitIntervals.YEARLY,
  [PrivacyVirtualCardLimitInterval.FOREVER]: VirtualCardLimitIntervals.ALL_TIME,
};

export type Merchant = {
  acceptor_id: string;
  city: string;
  country: string;
  descriptor: string;
  mcc: string;
  state: string;
};

export type Transaction = {
  // Absolute value in USD cents
  amount: number;
  card?: Card;
  card_token: string;
  // ISOString
  created: string;
  events: any[];
  funding: {
    // Absolute value in USD cents
    amount: number;
    token: string;
    type: string;
  }[];
  merchant: Merchant;
  // APPROVED otherwise a string with the reason why it was not approved
  result: 'APPROVED' | string;
  // Absolute value in USD cents
  settled_amount: number;
  status: 'PENDING' | 'VOIDED' | 'SETTLING' | 'SETTLED' | 'BOUNCED';
  token: string;
};
