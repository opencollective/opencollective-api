import config from 'config';

import { BadRequest } from '../graphql/errors';
import * as auth from '../lib/auth';
import emailLib from '../lib/email';
import errors from '../lib/errors';
import logger from '../lib/logger';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../lib/rate-limit';
import {
  verifyTwoFactorAuthenticationRecoveryCode,
  verifyTwoFactorAuthenticatorCode,
} from '../lib/two-factor-authentication';
import { isValidEmail, parseToBoolean } from '../lib/utils';
import models from '../models';

const { Unauthorized, ValidationFailed, TooManyRequests } = errors;

const { User } = models;

/**
 *
 * Public methods.
 *
 */

/**
 * Check existence of a user based on email
 */
export const exists = async (req, res) => {
  const email = req.query.email.toLowerCase();
  if (!isValidEmail(email)) {
    return res.send({ exists: false });
  } else {
    const rateLimit = new RateLimit(
      `user_email_search_ip_${req.ip}`,
      config.limits.searchEmailPerHourPerIp,
      ONE_HOUR_IN_SECONDS,
    );
    if (!(await rateLimit.registerCall())) {
      res.send({
        error: { message: 'Rate limit exceeded' },
      });
    }
    const user = await models.User.findOne({
      attributes: ['id'],
      where: { email },
    });
    return res.send({ exists: Boolean(user) });
  }
};

/**
 * Login or create a new user
 */
export const signin = (req, res, next) => {
  const { user, redirect, websiteUrl } = req.body;
  let loginLink;
  let clientIP;
  return models.User.findOne({ where: { email: user.email.toLowerCase() } })
    .then(u => u || models.User.createUserWithCollective(user))
    .then(u => {
      loginLink = u.generateLoginLink(redirect || '/', websiteUrl);
      clientIP = req.ip;
      if (config.env === 'development') {
        logger.info(`Login Link: ${loginLink}`);
      }
      return emailLib.send('user.new.token', u.email, { loginLink, clientIP }, { sendEvenIfNotProduction: true });
    })
    .then(() => {
      const response = { success: true };
      // For e2e testing, we enable testuser+(admin|member)@opencollective.com to automatically receive the login link
      if (config.env !== 'production' && user.email.match(/.*test.*@opencollective.com$/)) {
        response.redirect = loginLink;
      }
      return response;
    })
    .then(response => res.send(response))
    .catch(next);
};

/**
 * Receive a login JWT and generate another one.
 * This can be used right after the first login.
 * Also check if the user has two-factor authentication
 * enabled on their account, and if they do, we send
 * back a JWT with scope 'twofactorauth' to trigger
 * the 2FA flow on the frontend
 */
export const updateToken = async (req, res) => {
  const twoFactorAuthenticationEnabled = parseToBoolean(config.twoFactorAuthentication.enabled);
  if (twoFactorAuthenticationEnabled && req.remoteUser.twoFactorAuthToken !== null) {
    const token = req.remoteUser.jwt({ scope: 'twofactorauth' }, auth.TOKEN_EXPIRATION_SESSION);
    res.send({ token });
  } else {
    const token = req.remoteUser.jwt({}, auth.TOKEN_EXPIRATION_SESSION);
    res.send({ token });
  }
};

/**
 * Verify the 2FA code or recovery code the user has entered when logging in and send back another JWT.
 */
export const twoFactorAuthAndUpdateToken = async (req, res, next) => {
  const { twoFactorAuthenticatorCode, twoFactorAuthenticationRecoveryCode } = req.body;

  const userId = Number(req.jwtPayload.sub);

  // Both 2FA and recovery codes rate limited to 10 tries per hour
  const rateLimit = new RateLimit(`user_2FA_endpoint_${userId}`, 10, ONE_HOUR_IN_SECONDS);
  const fail = async exception => {
    await rateLimit.registerCall();
    next(exception);
  };

  if (await rateLimit.hasReachedLimit()) {
    return next(new TooManyRequests('Too many attempts. Please try again in an hour'));
  }

  const user = await User.findByPk(userId);
  if (!user) {
    logger.warn(`User id ${userId} not found`);
    next();
    return;
  }

  if (twoFactorAuthenticatorCode) {
    // if there is a 2FA code, we need to verify it before returning the token
    const verified = verifyTwoFactorAuthenticatorCode(user.twoFactorAuthToken, twoFactorAuthenticatorCode);
    if (!verified) {
      return fail(new Unauthorized('Two-factor authentication code failed. Please try again'));
    }
  } else if (twoFactorAuthenticationRecoveryCode) {
    // or if there is a recovery code try to verify it
    if (typeof twoFactorAuthenticationRecoveryCode !== 'string') {
      return fail(new ValidationFailed('2FA recovery code must be a string'));
    }
    const verified = verifyTwoFactorAuthenticationRecoveryCode(
      user.twoFactorAuthRecoveryCodes,
      twoFactorAuthenticationRecoveryCode,
    );
    if (!verified) {
      return fail(new Unauthorized('Two-factor authentication recovery code failed. Please try again'));
    }

    await user.update({ twoFactorAuthRecoveryCodes: null, twoFactorAuthToken: null });
  } else {
    return fail(new BadRequest('This endpoint requires you to provide a 2FA code or a recovery code'));
  }

  const token = user.jwt({}, auth.TOKEN_EXPIRATION_SESSION);
  res.send({ token: token });
};
