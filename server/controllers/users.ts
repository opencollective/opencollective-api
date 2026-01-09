/* eslint-disable custom-errors/no-unthrown-errors */
import bcrypt from 'bcrypt';
import config from 'config';
import type express from 'express';
import { omit } from 'lodash';

import { activities } from '../constants';
import { ENGINEERING_DOMAINS } from '../constants/engineering-domains';
import { BadRequest } from '../graphql/errors';
import * as auth from '../lib/auth';
import { sessionCache } from '../lib/cache';
import { checkCaptcha, isCaptchaSetup } from '../lib/check-captcha';
import emailLib from '../lib/email';
import { generateKey } from '../lib/encryption';
import errors from '../lib/errors';
import { confirmGuestAccount } from '../lib/guest-accounts';
import logger from '../lib/logger';
import { lockUntilOrThrow } from '../lib/mutex';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../lib/rate-limit';
import { HandlerType, reportErrorToSentry } from '../lib/sentry';
import twoFactorAuthLib, { TwoFactorMethod } from '../lib/two-factor-authentication';
import * as webauthn from '../lib/two-factor-authentication/webauthn';
import { isValidEmail, parseToBoolean } from '../lib/utils';
import models, { sequelize } from '../models';

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
export const exists = async (req: express.Request, res: express.Response) => {
  const email = (req.query.email as string).toLowerCase();
  if (!isValidEmail(email)) {
    res.send({ exists: false });
    return;
  } else {
    const rateLimit = new RateLimit(
      `user_email_search_ip_${req.ip}`,
      config.limits.search.email.perHourPerIp,
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
    res.send({ exists: Boolean(user) });
    return;
  }
};

/**
 * Login or create a new user
 *
 * TODO: we are passing createProfile from frontend to specify if we need to
 * create a new account. In the future once signin.js is fully deprecated (replaced by signinV2.js)
 * this function should be refactored to remove createProfile.
 */
export const signin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const { redirect, websiteUrl, sendLink, resetPassword, createProfile = true } = req.body;
  try {
    const rateLimit = new RateLimit(
      `user_signin_attempt_ip_${req.ip}`,
      config.limits.userSigninAttemptsPerHourPerIp,
      ONE_HOUR_IN_SECONDS,
      true,
    );
    if (!(await rateLimit.registerCall())) {
      res.status(403).send({
        error: { message: 'Rate limit exceeded' },
      });
      return;
    }
    let user = await models.User.findOne({ where: { email: req.body.user.email.toLowerCase() } });
    if (!user && !createProfile) {
      res.status(400).send({
        errorCode: 'EMAIL_DOES_NOT_EXIST',
        message: 'Email does not exist',
      });
      return;
    } else if (!user && createProfile) {
      user = await models.User.createUserWithCollective(req.body.user);
    } else if (!user.CollectiveId || user.data?.requiresVerification === true) {
      res.status(403).send({
        errorCode: 'EMAIL_AWAITING_VERIFICATION',
        message: 'Email awaiting verification',
      });
      return;
    }

    // If password set and not passed, challenge user with password
    if (user.passwordHash && !sendLink && !resetPassword) {
      if (!req.body.user.password) {
        res.status(403).send({
          errorCode: 'PASSWORD_REQUIRED',
          message: 'Password requested to complete sign in.',
        });
        return;
      }
      const validPassword = await bcrypt.compare(req.body.user.password, user.passwordHash);
      if (!validPassword) {
        // Would be great to be consistent in the way we send errors
        // This is what works best with Frontend today
        res.status(401).send({
          error: { errorCode: 'PASSWORD_INVALID', message: 'Invalid password' },
        });
        return;
      }

      const twoFactorAuthenticationEnabled = parseToBoolean(config.twoFactorAuthentication.enabled);
      if (twoFactorAuthenticationEnabled && (await twoFactorAuthLib.userHasTwoFactorAuthEnabled(user))) {
        const supported2FAMethods = await twoFactorAuthLib.twoFactorMethodsSupportedByUser(user);

        const authenticationOptions = {};

        if (supported2FAMethods.includes(TwoFactorMethod.WEBAUTHN)) {
          authenticationOptions['webauthn'] = await webauthn.authenticationOptions(user, req);
        }

        // Send 2FA token, can only be used to get a long term token
        const token = user.jwt(
          {
            scope: 'twofactorauth',
            supported2FAMethods,
            authenticationOptions,
          },
          auth.TOKEN_EXPIRATION_2FA,
        );
        res.send({ token });
        return;
      } else {
        // Context: this is token generation when using a password and no 2FA
        const token = await user.generateSessionToken({ createActivity: true, updateLastLoginAt: true, req });
        auth.setAuthCookie(res, token);
        res.send({ token });
        return;
      }
    }

    if (resetPassword) {
      const resetPasswordLink = user.generateResetPasswordLink({ websiteUrl });
      if (config.env === 'development') {
        logger.info(`Reset Password Link: ${resetPasswordLink}`);
      }
      try {
        await emailLib.send(
          activities.USER_RESET_PASSWORD,
          user.email,
          { resetPasswordLink, clientIP: req.ip },
          { sendEvenIfNotProduction: true },
        );
      } catch (e) {
        reportErrorToSentry(e, { user });
        res.status(500).send({
          error: { message: 'Error sending reset password email' },
        });
        return;
      }
    } else {
      const collective = await user.getCollective();
      const loginLink = user.generateLoginLink(redirect || '/', websiteUrl);
      const securitySettingsLink = new URL(loginLink);
      securitySettingsLink.searchParams.set('next', `/${collective.slug}/admin/user-security`);
      if (config.env === 'development') {
        logger.info(`Login Link: ${loginLink}`);
      }
      try {
        await emailLib.send(
          activities.USER_NEW_TOKEN,
          user.email,
          { loginLink, clientIP: req.ip, noPassword: !user.passwordHash, securitySettingsLink },
          { sendEvenIfNotProduction: true },
        );
      } catch (e) {
        reportErrorToSentry(e, { user });
        res.status(500).send({
          error: { message: 'Error sending login email' },
        });
        return;
      }

      // For e2e testing, we enable testuser+(admin|member)@opencollective.com to automatically receive the login link
      if (config.env !== 'production' && user.email.match(/.*test.*@opencollective.com$/)) {
        res.send({ success: true, redirect: loginLink });
        return;
      }
    }
    res.send({ success: true });
  } catch (e) {
    next(e);
  }
};

type SignupRequestSession = {
  sessionId: string;
  secret: string;
  tries: number;
  userId: number;
};

/**
 * Creates a new User and sends a new OTP verification code.
 */
export async function signup(req: express.Request, res: express.Response) {
  const { email, captcha } = req.body;
  if (captcha) {
    try {
      await checkCaptcha(captcha, req.ip);
    } catch {
      res.status(403).send({
        error: { message: 'Captcha verification failed', type: 'CAPTCHA_VERIFICATION_FAILED' },
      });
      return;
    }
  } else if (!req.remoteUser && isCaptchaSetup()) {
    res.status(403).send({
      error: { message: 'Captcha is required', type: 'CAPTCHA_REQUIRED' },
    });
    return;
  }

  const ipRateLimit = new RateLimit(
    `signup_ip_${req.ip}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
  );
  if (!(await ipRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  const sanitizedEmail = email?.toLowerCase()?.trim();
  if (!sanitizedEmail || !isValidEmail(sanitizedEmail)) {
    res.status(400).send({
      error: { message: 'Invalid email address', type: 'INVALID_EMAIL' },
    });
    return;
  }

  const emailRateLimit = new RateLimit(
    `signup_email_${sanitizedEmail}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
  );
  if (!(await emailRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  // Check if OTP request already exists
  const otpSessionKey = `otp_signup_${sanitizedEmail}`;
  const otpSession: SignupRequestSession = await sessionCache.get(otpSessionKey);
  if (otpSession) {
    res.status(401).send({
      error: { message: 'OTP request already exists', type: 'OTP_REQUEST_EXISTS' },
    });
    return;
  }

  // Check if Users exists
  let user = await models.User.findOne({
    where: { email: sanitizedEmail },
    include: [{ model: models.Collective, as: 'collective' }],
  });
  if (user) {
    if (user.confirmedAt) {
      res.status(403).send({
        error: { message: 'User already exists', type: 'USER_ALREADY_EXISTS' },
      });
      return;
    }
    if (user.collective) {
      const newData = Object.assign({}, user.collective.data, { requiresProfileCompletion: true });
      await user.collective.update({ data: newData });
    }
  } else {
    user = await sequelize.transaction(async transaction => {
      const user = await models.User.create(
        {
          email: sanitizedEmail,
          confirmedAt: null,
          data: {
            creationRequest: {
              ip: req.ip,
              userAgent: req.header('user-agent'),
            },
            requiresVerification: true,
          },
        },
        { transaction },
      );
      const collective = await user.createCollective(
        { data: { requiresProfileCompletion: true, isSuspended: true } },
        transaction,
      );
      await user.update({ CollectiveId: collective.id }, { transaction });
      return user;
    });
  }

  const otp = auth.generateOTPCode();
  if (config.env === 'development') {
    logger.info(`OTP Code for ${email}: ${otp}`);
  }
  const sessionId = generateKey();
  const secret = await bcrypt.hash(otp, 10);
  const session: SignupRequestSession = {
    sessionId,
    secret,
    tries: 0,
    userId: user.id,
  };
  await sessionCache.set(otpSessionKey, session, auth.OTP_TOKEN_EXPIRATION);
  try {
    await emailLib.send(
      activities.USER_OTP_REQUESTED,
      user.email,
      { otp, clientIP: req.ip, ttl: auth.OTP_TOKEN_EXPIRATION / 60 },
      { sendEvenIfNotProduction: true },
    );
  } catch (e) {
    reportErrorToSentry(e, { user, handler: HandlerType.EXPRESS, domain: ENGINEERING_DOMAINS.INDIVIDUAL_ONBOARDING });
    res.status(500).send({
      error: { message: 'Error sending OTP email', type: 'EMAIL_SEND_ERROR' },
    });
    return;
  }

  res.send({ success: true, sessionId });
}

export async function resendEmailVerificationOTP(req: express.Request, res: express.Response) {
  const { email, sessionId } = req.body;

  const ipRateLimit = new RateLimit(
    `resendOTP_ip_${req.ip}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
  );
  if (!(await ipRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  const sanitizedEmail = email?.toLowerCase()?.trim();
  if (!sanitizedEmail || !isValidEmail(sanitizedEmail)) {
    res.status(400).send({
      error: { message: 'Invalid email address', type: 'INVALID_EMAIL' },
    });
    return;
  }

  const emailRateLimit = new RateLimit(
    `resendOTP_email_${sanitizedEmail}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
  );
  if (!(await emailRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  // Check if OTP request already exists
  const otpSessionKey = `otp_signup_${sanitizedEmail}`;
  const existingSession: SignupRequestSession = await sessionCache.get(otpSessionKey);
  if (!sessionId || !existingSession || existingSession.sessionId !== sessionId) {
    res.status(401).send({
      error: { message: 'Cannot resend OTP because no OTP request was found', type: 'OTP_REQUEST_NOT_FOUND' },
    });
    return;
  }

  const user = await models.User.findByPk(existingSession.userId);
  if (!user || user.data?.requiresVerification !== true) {
    res.status(401).send({
      error: { message: 'User not found, try again', type: 'NOT_FOUND' },
    });
    return;
  }

  const otp = auth.generateOTPCode();
  if (config.env === 'development' || process.env.E2E_TEST) {
    logger.info(`OTP Code for ${email}: ${otp}`);
  }
  const secret = await bcrypt.hash(otp, 10);
  const session: SignupRequestSession = {
    sessionId,
    secret,
    tries: 0,
    userId: user.id,
  };
  await sessionCache.set(otpSessionKey, session, auth.OTP_TOKEN_EXPIRATION);
  try {
    await emailLib.send(
      activities.USER_OTP_REQUESTED,
      user.email,
      { otp, clientIP: req.ip, ttl: auth.OTP_TOKEN_EXPIRATION / 60 },
      { sendEvenIfNotProduction: true },
    );
  } catch (e) {
    reportErrorToSentry(e, { user, handler: HandlerType.EXPRESS, domain: ENGINEERING_DOMAINS.INDIVIDUAL_ONBOARDING });
    res.status(500).send({
      error: { message: 'Error sending OTP email', type: 'EMAIL_SEND_ERROR' },
    });
    return;
  }

  res.send({ success: true });
}

export async function verifyEmail(req: express.Request, res: express.Response) {
  const { email, otp, sessionId } = req.body;
  const sanitizedEmail = email?.toLowerCase()?.trim();
  if (!sanitizedEmail || !isValidEmail(sanitizedEmail)) {
    res.status(400).send({
      error: { message: 'Invalid email address', type: 'INVALID_EMAIL' },
    });
    return;
  }

  const ipRateLimit = new RateLimit(
    `verifyEmail_ip_${req.ip}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
  );
  if (!(await ipRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  const emailRateLimit = new RateLimit(
    `verifyEmail_email_${sanitizedEmail}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
  );
  if (!(await emailRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  try {
    await lockUntilOrThrow(
      `otp:verifyEmail:${sanitizedEmail}`,
      async () => {
        const otpSessionKey = `otp_signup_${sanitizedEmail}`;
        const otpSession: SignupRequestSession = await sessionCache.get(otpSessionKey);
        if (otpSession && otpSession.sessionId === sessionId) {
          const user = await models.User.findByPk(otpSession.userId, {
            include: [{ model: models.Collective, as: 'collective' }],
          });
          if (user) {
            const validOtp = await bcrypt.compare(otp, otpSession.secret);
            if (validOtp) {
              await sequelize.transaction(async transaction => {
                await user.update(
                  { confirmedAt: new Date(), data: omit(user.data, ['requiresVerification']) },
                  { transaction },
                );
                if (user.collective) {
                  let newData = omit(user.collective.data, ['isSuspended']);
                  if (user.collective.data?.isGuest) {
                    newData = { ...newData, isGuest: false, wasGuest: true, requiresProfileCompletion: true };
                  }
                  await user.collective.update({ data: newData }, { transaction });
                }
              });
              await sessionCache.delete(otpSessionKey);
              const token = await user.generateSessionToken({ createActivity: true, updateLastLoginAt: true, req });
              auth.setAuthCookie(res, token);
              res.send({ token, success: true });
              return;
            } else {
              const tries = otpSession.tries + 1;
              if (tries >= 3) {
                await sessionCache.delete(otpSessionKey);
                if (user.collective) {
                  const userHasTransactions = await user.collective.getTransactions({ limit: 1 });
                  // Covers edge-case where the user has previously contributed as guest
                  if (userHasTransactions.length === 0) {
                    await user.safeDestroy();
                  }
                }
              } else {
                await sessionCache.set(otpSessionKey, { ...otpSession, tries }, 15 * 60);
              }
            }
          } else {
            await sessionCache.delete(otpSessionKey);
          }
        }
      },
      {
        unlockTimeoutMs: 30 * 1000,
      },
    );
  } catch (e) {
    reportErrorToSentry(e, {
      extra: { email: sanitizedEmail },
      handler: HandlerType.EXPRESS,
      domain: ENGINEERING_DOMAINS.INDIVIDUAL_ONBOARDING,
    });
  }

  if (!res.headersSent) {
    res.status(403).send({ error: { message: 'Invalid or expired OTP code', type: 'INVALID_OTP' } });
  }
}

/**
 * Exchange a login JWT (received by email).

 * A) Check if the user has two-factor authentication
 * enabled on their account, and if they do, we send
 * back a JWT with scope 'twofactorauth' to trigger
 * the 2FA flow on the frontend
 *
 * B) If no 2FA, we send back a "session" token
 */
export const exchangeLoginToken = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const rateLimit = new RateLimit(
    `user_exchange_login_token_ip_${req.ip}`,
    config.limits.userExchangeLoginTokenPerHourPerIp,
    ONE_HOUR_IN_SECONDS,
    true,
  );
  if (!(await rateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded' },
    });
    return;
  }

  // This is already checked in checkJwtScope but lets' make it clear
  if (req.jwtPayload?.scope !== 'login') {
    const errorMessage = `Cannot use this token on this route (scope: ${
      req.jwtPayload?.scope || 'session'
    }, expected: login)`;
    next(new BadRequest(errorMessage));
    return;
  }

  // If a guest signs in, it's safe to directly confirm its account
  if (!req.remoteUser.confirmedAt) {
    await confirmGuestAccount(req.remoteUser);
  }

  const twoFactorAuthenticationEnabled = parseToBoolean(config.twoFactorAuthentication.enabled);
  if (twoFactorAuthenticationEnabled && (await twoFactorAuthLib.userHasTwoFactorAuthEnabled(req.remoteUser))) {
    const supported2FAMethods = await twoFactorAuthLib.twoFactorMethodsSupportedByUser(req.remoteUser);

    const authenticationOptions = {};

    if (supported2FAMethods.includes(TwoFactorMethod.WEBAUTHN)) {
      authenticationOptions['webauthn'] = await webauthn.authenticationOptions(req.remoteUser, req);
    }

    const token = req.remoteUser.jwt(
      {
        scope: 'twofactorauth',
        supported2FAMethods,
        authenticationOptions,
      },
      auth.TOKEN_EXPIRATION_2FA,
    );

    res.send({ token });
  } else {
    // Context: this is token generation after using a signin link (magic link) and no 2FA
    const token = await req.remoteUser.generateSessionToken({
      sessionId: req.jwtPayload.sessionId,
      createActivity: true,
      updateLastLoginAt: true,
      req,
    });
    auth.setAuthCookie(res, token);
    res.send({ token });
  }
};

/**
 * Exchange a session JWT against a fresh one with extended expiration
 */
export const refreshToken = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const rateLimit = new RateLimit(
    `user_refresh_token_ip_${req.ip}`,
    config.limits.userRefreshTokenPerHourPerIp,
    ONE_HOUR_IN_SECONDS,
    true,
  );
  if (!(await rateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded' },
    });
    return;
  }

  if (req.personalToken) {
    const errorMessage = `Cannot use this token on this route (personal token)`;
    next(new BadRequest(errorMessage));
    return;
  }

  if (req.jwtPayload?.scope && req.jwtPayload?.scope !== 'session') {
    const errorMessage = `Cannot use this token on this route (scope: ${req.jwtPayload?.scope}, expected: session)`;
    next(new BadRequest(errorMessage));
    return;
  }

  // TODO: not necessary once all oAuth tokens have the scope "oauth"
  if (req.jwtPayload?.access_token) {
    const errorMessage = `Cannot use this token on this route (oAuth access_token)`;
    next(new BadRequest(errorMessage));
    return;
  }

  // Context: this is token generation when extending a session
  const token = await req.remoteUser.generateSessionToken({
    sessionId: req.jwtPayload?.sessionId,
    createActivity: false,
    updateLastLoginAt: false,
  });
  auth.setAuthCookie(res, token);

  res.send({ token });
};

/**
 * Verify the 2FA code or recovery code the user has entered when logging in and send back another JWT.
 */
export const twoFactorAuthAndUpdateToken = async (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (req.jwtPayload?.scope !== 'twofactorauth') {
    const errorMessage = `Cannot use this token on this route (scope: ${
      req.jwtPayload?.scope || 'session'
    }, expected: twofactorauth)`;
    next(new BadRequest(errorMessage));
    return;
  }

  const { twoFactorAuthenticatorCode, twoFactorAuthenticationRecoveryCode, twoFactorAuthenticationType } = req.body;

  const userId = Number(req.jwtPayload.sub);

  // Both 2FA and recovery codes rate limited to 10 tries per hour
  const rateLimit = new RateLimit(`user_2FA_endpoint_${userId}`, 10, ONE_HOUR_IN_SECONDS);
  const fail = async exception => {
    await rateLimit.registerCall();
    next(exception);
  };

  if (await rateLimit.hasReachedLimit()) {
    next(new TooManyRequests('Too many attempts. Please try again in an hour'));
    return;
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
    fail(new BadRequest('This endpoint requires you to provide a 2FA code or a recovery code'));
    return;
  }

  try {
    await twoFactorAuthLib.validateToken(
      user,
      {
        code: code,
        type: type,
      },
      req,
    );
  } catch {
    fail(new Unauthorized('Two-factor authentication code failed. Please try again'));
    return;
  }

  // Context: this is token generation after signin and valid 2FA authentication
  const token = await user.generateSessionToken({
    sessionId: req.jwtPayload.sessionId,
    createActivity: true,
    updateLastLoginAt: true,
    req,
  });
  auth.setAuthCookie(res, token);

  res.send({ token: token });
};
