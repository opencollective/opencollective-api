import config from 'config';
import jwt from 'jsonwebtoken';
import moment from 'moment';
import { randomInt } from 'node:crypto';

import * as errors from '../graphql/errors';

import { crypto, generateKey } from './encryption';

// Helper
const daysToSeconds = days => moment.duration({ days }).asSeconds();
const minutesToSeconds = minutes => moment.duration({ minutes }).asSeconds();

/* Constants that determine token expiration */
export const TOKEN_EXPIRATION_LOGIN = minutesToSeconds(75);
export const TOKEN_EXPIRATION_RESET_PASSWORD = minutesToSeconds(75);
export const TOKEN_EXPIRATION_2FA = minutesToSeconds(15);
export const TOKEN_EXPIRATION_CONNECTED_ACCOUNT = daysToSeconds(1);
export const TOKEN_EXPIRATION_SESSION = daysToSeconds(30);
export const TOKEN_EXPIRATION_SESSION_OAUTH = daysToSeconds(90);
export const TOKEN_EXPIRATION_PDF = minutesToSeconds(5);
export const TOKEN_EXPIRATION_CSV = minutesToSeconds(5);

export const ALGORITHM = 'HS256';
export const KID = 'HS256-2019-09-02';

/** Generate a JWToken with the received parameters */
export function createJwt(subject, payload: { scope?: string; sessionId?: string } = {}, expiresIn: number) {
  if (payload?.scope === 'session') {
    if (!payload.sessionId) {
      payload.sessionId = crypto.hash(generateKey());
    }
  }
  return jwt.sign(payload, config.keys.opencollective.jwtSecret, {
    expiresIn: expiresIn,
    subject: String(subject),
    algorithm: ALGORITHM,
    header: {
      kid: KID,
    },
  } as jwt.SignOptions);
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

/**
 * @param {Express.Response} res
 * @param {string} token
 * */
export function setAuthCookie(res, token) {
  const decodedToken = verifyJwt(token) as jwt.JwtPayload;

  const maxAge = decodedToken.exp * 1000 - new Date().getTime();
  const [header, payload, signature] = token.split('.');
  res.cookie('accessTokenPayload', [header, payload].join('.'), { maxAge, httpOnly: false, secure: true });
  res.cookie('accessTokenSignature', signature, { maxAge, httpOnly: true, secure: true });
}

export const OTP_RATE_LIMIT_WINDOW = minutesToSeconds(15);
export const OTP_RATE_LIMIT_MAX_ATTEMPTS = 5;
export const OTP_TOKEN_EXPIRATION = minutesToSeconds(5);

export function generateOTPCode(length = 6): string {
  return randomInt(0, 10 ** length - 1)
    .toString()
    .padStart(length, '0');
}
