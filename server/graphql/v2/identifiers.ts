import crypto from 'crypto';

import config from 'config';
import Hashids from 'hashids/cjs';

import { BadRequest } from '../errors';

const alphabet = '1234567890abcdefghijklmnopqrstuvwxyz';

let salt = config.keys.opencollective.hashidSalt;
if (!salt) {
  console.warn('Please define HASHID_SALT to get permanent public ids.');
  salt = crypto.randomBytes(64).toString('hex');
}

const instances = {};

export const IDENTIFIER_TYPES = {
  ACCOUNT: 'account',
  ACCOUNTING_CATEGORY: 'accounting-category',
  ACTIVITY: 'activity',
  AGREEMENT: 'agreement',
  COMMENT: 'comment',
  COMMENT_REACTION: 'comment-reaction',
  CONVERSATION: 'conversation',
  HOST_APPLICATION: 'host-application',
  MEMBER: 'member',
  MEMBER_INVITATION: 'member-invitation',
  PAYOUT_METHOD: 'payout-method',
  PAYMENT_METHOD: 'paymentMethod',
  EXPENSE: 'expense',
  CONNECTED_ACCOUNT: 'connected-account',
  EXPENSE_ATTACHED_FILE: 'expense-attached-file',
  EXPENSE_ITEM: 'expense-item',
  LEGAL_DOCUMENT: 'legal-document',
  RECURRING_EXPENSE: 'recurring-expense',
  TIER: 'tier',
  ORDER: 'order',
  UPDATE: 'update',
  APPLICATION: 'application',
  USER_TOKEN: 'user-token',
  NOTIFICATION: 'notification',
  PERSONAL_TOKEN: 'personal-token',
  UPLOADED_FILE: 'uploaded-file',
  USER: 'user',
  USER_TWO_FACTOR_METHOD: 'user-two-factor-method',
  VIRTUAL_CARD_REQUEST: 'virtual-card-request',
  TRANSACTIONS_IMPORT: 'transactions-import',
  TRANSACTIONS_IMPORT_ROW: 'transactions-import-row',
} as const;

type IdentifierType = (typeof IDENTIFIER_TYPES)[keyof typeof IDENTIFIER_TYPES];

const getDefaultInstance = (type: IdentifierType): Hashids => {
  switch (type) {
    case IDENTIFIER_TYPES.CONVERSATION:
      return new Hashids(salt + type, 8, alphabet);
    default:
      return new Hashids(salt + type, 32, alphabet);
  }
};

const getInstance = (type: IdentifierType): Hashids => {
  let instance = instances[type];
  if (!instance) {
    instance = instances[type] = getDefaultInstance(type);
  }

  return instance;
};

function chunkStr(str: string, size: number): string[] {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.substring(i, i + size));
  }

  return chunks;
}

export const idEncode = (integer: number, type: IdentifierType): string => {
  const string = getInstance(type).encode(integer);
  if (string.length > 8) {
    return chunkStr(string, 8).join('-');
  } else {
    return string;
  }
};

export const idDecode = (string: string, type: IdentifierType): number => {
  const [decoded] = getInstance(type).decode(string.split('-').join(''));
  if (decoded === undefined) {
    throw new BadRequest(`Invalid ${type} id: ${string}`);
  }

  return Number(decoded);
};

/**
 * Returns a function to be used as the resolver for identifier fields.
 * The returned resolver function encodes the identifier field (idField)
 * @param {string} type - Type the fields belongs to. For example: 'comment' and 'transaction'
 * @param {string} idField - Field that represents the id. By default 'id'
 */
export const getIdEncodeResolver =
  (type: IdentifierType, idField = 'id') =>
  entity =>
    idEncode(entity[idField], type);
