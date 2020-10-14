import Promise from 'bluebird';
import config from 'config';
import jwt from 'jsonwebtoken';
import { isNil } from 'lodash';
import moment from 'moment';
import speakeasy from 'speakeasy';

import * as errors from '../graphql/errors';
import models, { Op } from '../models';

import cache from './cache';
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

const getCacheKey = userId => {
  return `${userId}_2fa_payment_limit`;
};

export async function rollingPayoutLimitTwoFactorAuthentication(
  req,
  twoFactorAuthenticatorCode,
  hostRollingLimit,
  expenseAmount,
) {
  if (req.remoteUser.twoFactorAuthToken !== null) {
    // 1. we check the 'cache' if the key exists: cacheKey=${user.id}_2fa_payment_limit
    const userId = req.remoteUser.id;
    const cacheKey = getCacheKey(userId);
    const keyInCache = await cache.get(cacheKey);

    if (twoFactorAuthenticatorCode) {
      const verified = verifyTwoFactorAuthenticatorCode(req.remoteUser.twoFactorAuthToken, twoFactorAuthenticatorCode);
      if (!verified) {
        throw new Error('Two-factor authentication failed: invalid code. Please try again.');
      }
      // With 2FA code
      // 2. if limit key exists, reset the limit; if limit key doesn't exist, initialise the limit
      return {
        cacheKey,
        cacheValue: 0,
      };
    } else {
      // Without 2FA code
      // 2. if the limit key does exist, check the value
      // 3. if the payment fits the limit, process the payment, decrease the limit
      // 4. if it doesn't fit the limit, prompt 2FA again
      if (isNil(keyInCache)) {
        // 5. if the limit key doesn't exist, ask for 2FA
        throw new Error('Two-factor authentication enabled: please enter your code.');
      } else {
        const runningTotal = keyInCache + expenseAmount;
        const expenseExceedsRollingLimit = runningTotal > hostRollingLimit;
        if (expenseExceedsRollingLimit) {
          throw new Error('Two-factor authentication payout limit exceeded: please re-enter your code.');
        } else {
          return {
            cacheKey,
            cacheValue: runningTotal,
          };
        }
      }
    }
  } else {
    throw new Error('Host has two-factor authentication enabled for large payouts.');
  }
}
