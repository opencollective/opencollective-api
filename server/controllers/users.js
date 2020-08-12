import config from 'config';
import speakeasy from 'speakeasy';

import * as auth from '../lib/auth';
import emailLib from '../lib/email';
import { crypto } from '../lib/encryption';
import errors from '../lib/errors';
import logger from '../lib/logger';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../lib/rate-limit';
import { isValidEmail } from '../lib/utils';
import models from '../models';

const { Unauthorized } = errors;

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
      if (process.env.NODE_ENV !== 'production' && user.email.match(/.*test.*@opencollective.com$/)) {
        response.redirect = loginLink;
      }
      return response;
    })
    .then(response => res.send(response))
    .catch(next);
};

/**
 * Receive a JWT and generate another one.
 * This can be used right after the first login.
 * If an authenticator code is sent, check if
 * the user has two-factor authentication enabled
 * on their account, and if they do, we challenge
 * them to auth with it during the login flow
 */
export const updateToken = async (req, res, next) => {
  const { twoFactorAuthenticatorCode } = req.body;

  // the first time we try, we need to just check if the user has 2FA
  if (req.remoteUser.twoFactorAuthToken !== null && !twoFactorAuthenticatorCode) {
    return next(new Unauthorized('Two-factor authentication is enabled on this account. Please enter the code'));
  }

  // we process a new token the 1st time if no 2FA, 2nd time if there is
  const token = req.remoteUser.jwt({}, auth.TOKEN_EXPIRATION_SESSION);

  // if there is a 2FA code we need to verify it before returning the token
  if (twoFactorAuthenticatorCode) {
    const encryptedTwoFactorAuthToken = req.remoteUser.twoFactorAuthToken;
    const decryptedTwoFactorAuthToken = crypto.decrypt(encryptedTwoFactorAuthToken);
    const verified = speakeasy.totp.verify({
      secret: decryptedTwoFactorAuthToken,
      encoding: 'base32',
      token: twoFactorAuthenticatorCode,
      window: 2,
    });
    if (!verified) {
      return next(new Unauthorized('Two-factor authentication code failed. Please try again'));
    }
    res.send({ token: token });
  } else {
    // otherwise just send the jwt token back
    res.send({ token });
  }
};
