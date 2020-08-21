import Promise from 'bluebird';
import config from 'config';
import jwt from 'jsonwebtoken';
import moment from 'moment';
import speakeasy from 'speakeasy';

import * as errors from '../graphql/errors';
import models, { Op } from '../models';

import { crypto } from './encryption';

// Helper
const daysToSeconds = days => moment.duration({ days }).asSeconds();
const minutesToSeconds = minutes => moment.duration({ minutes }).asSeconds();

/* Constants that determin token expiration */
export const TOKEN_EXPIRATION_LOGIN = minutesToSeconds(75);
export const TOKEN_EXPIRATION_CONNECTED_ACCOUNT = daysToSeconds(1);
export const TOKEN_EXPIRATION_SESSION = daysToSeconds(90);

const ALGORITHM = 'HS256';
const KID = 'HS256-2019-09-02';

/** Generate a JWToken with the received parameters */
export function createJwt(subject, payload, expiresIn) {
  return jwt.sign(payload || {}, config.keys.opencollective.jwtSecret, {
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

/**
 * Returns the subset of [User|Organization]CollectiveIds that the remoteUser has access to
 */
export function getListOfAccessibleMembers(remoteUser, CollectiveIds) {
  if (!remoteUser) {
    return Promise.resolve([]);
  }
  if (!remoteUser.rolesByCollectiveId) {
    return Promise.resolve([]);
  }
  // all the CollectiveIds that the remoteUser is admin of.
  const adminOfCollectives = Object.keys(remoteUser.rolesByCollectiveId).filter(CollectiveId =>
    remoteUser.isAdmin(CollectiveId),
  );
  return models.Member.findAll({
    attributes: ['MemberCollectiveId'],
    where: {
      MemberCollectiveId: { [Op.in]: CollectiveIds },
      CollectiveId: { [Op.in]: adminOfCollectives },
    },
    group: ['MemberCollectiveId'],
  }).then(results => results.map(r => r.MemberCollectiveId));
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
 * Verifies a TOTP against a user's 2FA token saved in the DB
 * encryptedTwoFactorAuthToken = token saved for a User in the DB
 * twoFactorAuthenticatorCode = 6-digit TOTP
 */
export function verifyTwoFactorAuthenticatorCode(encryptedTwoFactorAuthToken, twoFactorAuthenticatorCode) {
  const decryptedTwoFactorAuthToken = crypto.decrypt(encryptedTwoFactorAuthToken);
  const verified = speakeasy.totp.verify({
    secret: decryptedTwoFactorAuthToken,
    encoding: 'base32',
    token: twoFactorAuthenticatorCode,
    window: 2,
  });
  return verified;
}

export function enforceTwoFactorAuthenticationOnPayouts(req, twoFactorAuthenticatorCode) {
  if (req.remoteUser.twoFactorAuthToken !== null) {
    if (twoFactorAuthenticatorCode) {
      const verified = verifyTwoFactorAuthenticatorCode(req.remoteUser.twoFactorAuthToken, twoFactorAuthenticatorCode);
      if (!verified) {
        throw new Error('Two-factor authentication failed: invalid code. Please try again.');
      }
      return;
    } else {
      throw new Error('Two-factor authentication enabled: please enter your code.');
    }
  } else {
    throw new Error('Host has two-factor authentication enabled for large payouts.');
  }
}
