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
  ACTIVITY: 'activity',
  COMMENT: 'comment',
  COMMENT_REACTION: 'comment-reaction',
  CONVERSATION: 'conversation',
  HOST_APPLICATION: 'host-application',
  MEMBER_INVITATION: 'member-invitation',
  PAYOUT_METHOD: 'payout-method',
  PAYMENT_METHOD: 'paymentMethod',
  EXPENSE: 'expense',
  CONNECTED_ACCOUNT: 'connected-account',
  EXPENSE_ATTACHED_FILE: 'expense-attached-file',
  EXPENSE_ITEM: 'expense-item',
  RECURRING_EXPENSE: 'recurring-expense',
  TIER: 'tier',
  ORDER: 'order',
  UPDATE: 'update',
  APPLICATION: 'application',
  USER_TOKEN: 'user-token',
  NOTIFICATION: 'notification',
  PERSONAL_TOKEN: 'personal-token',
};

const getDefaultInstance = type => {
  switch (type) {
    case IDENTIFIER_TYPES.CONVERSATION:
      return new Hashids(salt + type, 8, alphabet);
    default:
      return new Hashids(salt + type, 32, alphabet);
  }
};

const getInstance = type => {
  let instance = instances[type];
  if (!instance) {
    instance = instances[type] = getDefaultInstance(type);
  }

  return instance;
};

function chunkStr(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.substring(i, i + size));
  }

  return chunks;
}

export const idEncode = (integer, type) => {
  const string = getInstance(type).encode(integer);
  if (string.length > 8) {
    return chunkStr(string, 8).join('-');
  } else {
    return string;
  }
};

export const idDecode = (string, type) => {
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
  (type, idField = 'id') =>
  entity =>
    idEncode(entity[idField], type);
