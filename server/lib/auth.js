import config from 'config';
import jwt from 'jsonwebtoken';
import moment from 'moment';

import * as errors from '../graphql/errors';

import { crypto, generateKey } from './encryption';

// Helper
const daysToSeconds = days => moment.duration({ days }).asSeconds();
const minutesToSeconds = minutes => moment.duration({ minutes }).asSeconds();

/* Constants that determine token expiration */
export const TOKEN_EXPIRATION_LOGIN = minutesToSeconds(75);
export const TOKEN_EXPIRATION_CONNECTED_ACCOUNT = daysToSeconds(1);
export const TOKEN_EXPIRATION_SESSION = daysToSeconds(90);
export const TOKEN_EXPIRATION_PDF = minutesToSeconds(5);
export const TOKEN_EXPIRATION_CSV = minutesToSeconds(5);

export const ALGORITHM = 'HS256';
export const KID = 'HS256-2019-09-02';

/** Generate a JWToken with the received parameters */
export function createJwt(subject, payload, expiresIn) {
  const sessionId = payload?.sessionId || crypto.hash(generateKey(256));
  return jwt.sign({ ...payload, sessionId }, config.keys.opencollective.jwtSecret, {
    expiresIn,
    subject: String(subject),
    algorithm: ALGORITHM,
    header: {
      kid: KID,
    },
  });
}

/** Verify JWToken */
export function verifyJwt(token) {
  return jwt.verify(token, config.keys.opencollective.jwtSecret, {
    algorithms: [ALGORITHM],
  });
}

export function mustBeLoggedInTo(remoteUser, action = 'do this') {
  if (!remoteUser) {
    throw new errors.Unauthorized(`You must be logged in to ${action}`);
  }
}

export function mustHaveRole(remoteUser, roles, CollectiveId, action = 'perform this action') {
  mustBeLoggedInTo(remoteUser, action);
  if (!CollectiveId || !remoteUser.hasRole(roles, CollectiveId)) {
    throw new errors.Unauthorized(`You don't have sufficient permissions to ${action}`);
  }
}
