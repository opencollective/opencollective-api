import bcrypt from 'bcrypt';
import config from 'config';

import { activities } from '../constants';
import { BadRequest } from '../graphql/errors';
import * as auth from '../lib/auth';
import emailLib from '../lib/email';
import errors from '../lib/errors';
import { confirmGuestAccount } from '../lib/guest-accounts';
import logger from '../lib/logger';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../lib/rate-limit';
import twoFactorAuthLib, { TwoFactorMethod } from '../lib/two-factor-authentication';
import { isValidEmail, parseToBoolean } from '../lib/utils';
import models from '../models';

const { Unauthorized, TooManyRequests } = errors;

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
 *
 * TODO: we are passing createProfile from frontend to specify if we need to
 * create a new account. In the future once signin.js is fully deprecated (replaced by signinV2.js)
 * this function should be refactored to remove createProfile.
 */
export const signin = async (req, res, next) => {
  const { redirect, websiteUrl, sendLink, resetPassword, createProfile = true } = req.body;
  try {
    const rateLimit = new RateLimit(
      `user_signin_attempt_ip_${req.ip}`,
      config.limits.userSigninAttemptsPerHourPerIp,
      ONE_HOUR_IN_SECONDS,
      true,
    );
    if (!(await rateLimit.registerCall())) {
      return res.status(403).send({
        error: { message: 'Rate limit exceeded' },
      });
    }
    let user = await models.User.findOne({ where: { email: req.body.user.email.toLowerCase() } });
    if (!user && !createProfile) {
      return res.status(400).send({
        errorCode: 'EMAIL_DOES_NOT_EXIST',
        message: 'Email does not exist',
      });
    } else if (!user && createProfile) {
      user = await models.User.createUserWithCollective(req.body.user);
    }

    // If password set and not passed, challenge user with password
    if (user.passwordHash && !sendLink && !resetPassword) {
      if (!req.body.user.password) {
        return res.status(403).send({
          errorCode: 'PASSWORD_REQUIRED',
          message: 'Password requested to complete sign in.',
        });
      }
      const validPassword = await bcrypt.compare(req.body.user.password, user.passwordHash);
      if (!validPassword) {
        // Would be great to be consistent in the way we send errors
        // This is what works best with Frontend today
        return res.status(401).send({
          error: { message: 'Invalid password' },
        });
      }

      const twoFactorAuthenticationEnabled = parseToBoolean(config.twoFactorAuthentication.enabled);
      if (twoFactorAuthenticationEnabled && twoFactorAuthLib.userHasTwoFactorAuthEnabled(user)) {
        // Send 2FA token, can only be used to get a long term token
        const token = user.jwt(
          {
            scope: 'twofactorauth',
            supported2FAMethods: [
              TwoFactorMethod.RECOVERY_CODE,
              ...(await twoFactorAuthLib.twoFactorMethodsSupportedByUser(user)),
            ],
          },
          auth.TOKEN_EXPIRATION_2FA,
        );
        return res.send({ token });
      } else {
        // All good, no 2FA, send token
        const token = await user.generateSessionToken();
        return res.send({ token });
      }
    }

    if (resetPassword) {
      const resetPasswordLink = user.generateResetPasswordLink({ websiteUrl });
      if (config.env === 'development') {
        logger.info(`Reset Password Link: ${resetPasswordLink}`);
      }
      await emailLib.send(
        activities.USER_RESET_PASSWORD,
        user.email,
        { resetPasswordLink, clientIP: req.ip },
        { sendEvenIfNotProduction: true },
      );
    } else {
      const collective = await user.getCollective();
      const loginLink = user.generateLoginLink(redirect || '/', websiteUrl);
      const securitySettingsLink = new URL(loginLink);
      securitySettingsLink.searchParams.set('next', `/${collective.slug}/admin/user-security`);
      if (config.env === 'development') {
        logger.info(`Login Link: ${loginLink}`);
      }
      await emailLib.send(
        activities.USER_NEW_TOKEN,
        user.email,
        { loginLink, clientIP: req.ip, noPassword: !user.passwordHash, securitySettingsLink },
        { sendEvenIfNotProduction: true },
      );

      // For e2e testing, we enable testuser+(admin|member)@opencollective.com to automatically receive the login link
      if (config.env !== 'production' && user.email.match(/.*test.*@opencollective.com$/)) {
        return res.send({ success: true, redirect: loginLink });
      }
    }

    res.send({ success: true });
  } catch (e) {
    next(e);
  }
};

/**
 * Exchange a login JWT (received by email).

 * A) Check if the user has two-factor authentication
 * enabled on their account, and if they do, we send
 * back a JWT with scope 'twofactorauth' to trigger
 * the 2FA flow on the frontend
 *
 * B) If no 2FA, we send back a "session" token
 */
export const exchangeLoginToken = async (req, res, next) => {
  const rateLimit = new RateLimit(
    `user_exchange_login_token_ip_${req.ip}`,
    config.limits.userExchangeLoginTokenPerHourPerIp,
    ONE_HOUR_IN_SECONDS,
    true,
  );
  if (!(await rateLimit.registerCall())) {
    return res.status(403).send({
      error: { message: 'Rate limit exceeded' },
    });
  }

  // This is already checked in checkJwtScope but lets' make it clear
  if (req.jwtPayload?.scope !== 'login') {
    const errorMessage = `Cannot use this token on this route (scope: ${
      req.jwtPayload?.scope || 'session'
    }, expected: login)`;
    return next(new BadRequest(errorMessage));
  }

  // If a guest signs in, it's safe to directly confirm its account
  if (!req.remoteUser.confirmedAt) {
    await confirmGuestAccount(req.remoteUser);
  }

  const twoFactorAuthenticationEnabled = parseToBoolean(config.twoFactorAuthentication.enabled);
  if (twoFactorAuthenticationEnabled && (await twoFactorAuthLib.userHasTwoFactorAuthEnabled(req.remoteUser))) {
    const token = req.remoteUser.jwt(
      {
        scope: 'twofactorauth',
        supported2FAMethods: [
          TwoFactorMethod.RECOVERY_CODE,
          ...(await twoFactorAuthLib.twoFactorMethodsSupportedByUser(req.remoteUser)),
        ],
      },
      auth.TOKEN_EXPIRATION_2FA,
    );
    res.send({ token });
  } else {
    const token = await req.remoteUser.generateSessionToken({ sessionId: req.jwtPayload?.sessionId });
    res.send({ token });
  }
};

/**
 * Exchange a session JWT against a fresh one with extended expiration
 */
export const refreshToken = async (req, res, next) => {
  const rateLimit = new RateLimit(
    `user_refresh_token_ip_${req.ip}`,
    config.limits.userRefreshTokenPerHourPerIp,
    ONE_HOUR_IN_SECONDS,
    true,
  );
  if (!(await rateLimit.registerCall())) {
    return res.status(403).send({
      error: { message: 'Rate limit exceeded' },
    });
  }

  if (req.personalToken) {
    const errorMessage = `Cannot use this token on this route (personal token)`;
    return next(new BadRequest(errorMessage));
  }

  if (req.jwtPayload?.scope && req.jwtPayload?.scope !== 'session') {
    const errorMessage = `Cannot use this token on this route (scope: ${req.jwtPayload?.scope}, expected: session)`;
    return next(new BadRequest(errorMessage));
  }

  // TODO: not necessary once all oAuth tokens have the scope "oauth"
  if (req.jwtPayload?.access_token) {
    const errorMessage = `Cannot use this token on this route (oAuth access_token)`;
    return next(new BadRequest(errorMessage));
  }

  const token = await req.remoteUser.generateSessionToken({ sessionId: req.jwtPayload?.sessionId });
  res.send({ token });
};

/**
 * Verify the 2FA code or recovery code the user has entered when logging in and send back another JWT.
 */
export const twoFactorAuthAndUpdateToken = async (req, res, next) => {
  if (req.jwtPayload?.scope !== 'twofactorauth') {
    const errorMessage = `Cannot use this token on this route (scope: ${
      req.jwtPayload?.scope || 'session'
    }, expected: twofactorauth)`;
    return next(new BadRequest(errorMessage));
  }

  const { twoFactorAuthenticatorCode, twoFactorAuthenticationRecoveryCode, twoFactorAuthenticationType } = req.body;

  const userId = Number(req.jwtPayload.sub);
  const sessionId = req.jwtPayload.sessionId;

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

  const code = twoFactorAuthenticatorCode || twoFactorAuthenticationRecoveryCode;
  const type =
    twoFactorAuthenticationType ?? (twoFactorAuthenticatorCode ? TwoFactorMethod.TOTP : TwoFactorMethod.RECOVERY_CODE);

  if (!code) {
    return fail(new BadRequest('This endpoint requires you to provide a 2FA code or a recovery code'));
  }

  try {
    await twoFactorAuthLib.validateToken(user, {
      code: code,
      type: type,
    });
  } catch (e) {
    return fail(new Unauthorized('Two-factor authentication code failed. Please try again'));
  }

  const token = await user.generateSessionToken({ sessionId });
  res.send({ token: token });
};
