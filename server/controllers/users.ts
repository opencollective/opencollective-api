/* eslint-disable custom-errors/no-unthrown-errors */
import bcrypt from 'bcrypt';
import config from 'config';
import type express from 'express';

import { activities } from '../constants';
import { ENGINEERING_DOMAINS } from '../constants/engineering-domains';
import { BadRequest } from '../graphql/errors';
import * as auth from '../lib/auth';
import { sessionCache } from '../lib/cache';
import { checkCaptcha, isCaptchaSetup } from '../lib/check-captcha';
import emailLib from '../lib/email';
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
export const exists = async (req, res) => {
  const email = req.query.email.toLowerCase();
  if (!isValidEmail(email)) {
    return res.send({ exists: false });
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
    } else if (!user.CollectiveId) {
      return res.status(403).send({
        errorCode: 'EMAIL_AWAITING_VERIFICATION',
        message: 'Email awaiting verification',
      });
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
          error: { errorCode: 'PASSWORD_INVALID', message: 'Invalid password' },
        });
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
        return res.send({ token });
      } else {
        // Context: this is token generation when using a password and no 2FA
        const token = await user.generateSessionToken({ createActivity: true, updateLastLoginAt: true, req });
        auth.setAuthCookie(res, token);
        return res.send({ token });
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
        return res.status(500).send({
          error: { message: 'Error sending reset password email' },
        });
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
        return res.status(500).send({
          error: { message: 'Error sending login email' },
        });
      }

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

type SignupRequestSession = {
  secret: string;
  tries: number;
  userId: number;
};

/**
 * Creates a new User and sends a new OTP verification code.
 */
export async function signup(req: express.Request, res: express.Response) {
  const { email, password, captcha } = req.body;
  if (captcha) {
    await checkCaptcha(captcha, req.ip);
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
    true,
  );
  if (!(await ipRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  const sanitizedEmail = email.toLowerCase();
  const otpSessionKey = `otp_signup_${sanitizedEmail}`;

  if (!isValidEmail(sanitizedEmail)) {
    res.status(400).send({
      error: { message: 'Invalid email address', type: 'INVALID_EMAIL' },
    });
    return;
  }
  const emailRateLimit = new RateLimit(
    `signup_email_${sanitizedEmail}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
    true,
  );
  if (!(await emailRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  // Check if OTP request already exists
  const otpSession: SignupRequestSession = await sessionCache.get(otpSessionKey);
  if (otpSession) {
    // Should we just return SUCCESS true here to take the user to the verify OTP step?
    res.status(401).send({
      error: { message: 'OTP request already exists', type: 'OTP_REQUEST_EXISTS' },
    });
    return;
  }

  // Check if Users exists
  let user = await models.User.findOne({ where: { email: sanitizedEmail } });
  if (user) {
    if (user.confirmedAt) {
      res.status(403).send({
        error: { message: 'User already exists', type: 'USER_ALREADY_EXISTS' },
      });
      return;
    }
  } else {
    user = await models.User.create({
      email: sanitizedEmail,
      confirmedAt: null,
      data: {
        creationRequest: {
          ip: req.ip,
          userAgent: req.header('user-agent'),
        },
      },
    });
    if (password) {
      await user.setPassword(password);
    }
  }

  const otp = auth.generateOTPCode();
  if (config.env === 'development') {
    logger.info(`OTP Code for ${email}: ${otp}`);
  }
  const secret = await bcrypt.hash(otp, 10);
  const session: SignupRequestSession = {
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

export async function resendEmailVerificationOTP(req: express.Request, res: express.Response) {
  const { email } = req.body;

  const ipRateLimit = new RateLimit(
    `resendOTP_ip_${req.ip}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
    true,
  );
  if (!(await ipRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  const sanitizedEmail = email.toLowerCase();
  const otpSessionKey = `otp_signup_${sanitizedEmail}`;

  if (!isValidEmail(sanitizedEmail)) {
    res.status(400).send({
      error: { message: 'Invalid email address', type: 'INVALID_EMAIL' },
    });
    return;
  }
  const emailRateLimit = new RateLimit(
    `resendOTP_email_${sanitizedEmail}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
    true,
  );
  if (!(await emailRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  }

  // Check if OTP request already exists
  const existingSession: SignupRequestSession = await sessionCache.get(otpSessionKey);
  if (!existingSession) {
    res.status(401).send({
      error: { message: 'Cannot resend OTP because no OTP request was found', type: 'OTP_REQUEST_NOT_FOUND' },
    });
    return;
  }

  const user = await models.User.findByPk(existingSession.userId);
  if (!user) {
    res.status(500).send({
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
  const { email, otp } = req.body;
  const sanitizedEmail = email.toLowerCase();
  if (!isValidEmail(sanitizedEmail)) {
    res.status(400).send({
      error: { message: 'Invalid email address', type: 'INVALID_EMAIL' },
    });
    return;
  }

  const emailRateLimit = new RateLimit(
    `verifyEmail_email_${sanitizedEmail}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
    true,
  );
  const ipRateLimit = new RateLimit(
    `verifyEmail_ip_${req.ip}`,
    auth.OTP_RATE_LIMIT_MAX_ATTEMPTS,
    auth.OTP_RATE_LIMIT_WINDOW,
    true,
  );
  if (!(await emailRateLimit.registerCall())) {
    res.status(403).send({
      error: { message: 'Rate limit exceeded', type: 'RATE_LIMIT_EXCEEDED' },
    });
    return;
  } else if (!(await ipRateLimit.registerCall())) {
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
        if (otpSession) {
          const user = await models.User.findByPk(otpSession.userId);
          if (user) {
            const validOtp = await bcrypt.compare(otp, otpSession.secret);
            if (validOtp) {
              await sequelize.transaction(async transaction => {
                const collective = await user.createCollective(
                  { name: sanitizedEmail.split('@')[0], data: { requiresProfileCompletion: true } },
                  transaction,
                );
                await user.update({ confirmedAt: new Date(), CollectiveId: collective.id }, { transaction });
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
                await user.safeDestroy();
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
export const twoFactorAuthAndUpdateToken = async (req, res, next) => {
  if (req.jwtPayload?.scope !== 'twofactorauth') {
    const errorMessage = `Cannot use this token on this route (scope: ${
      req.jwtPayload?.scope || 'session'
    }, expected: twofactorauth)`;
    return next(new BadRequest(errorMessage));
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
    await twoFactorAuthLib.validateToken(
      user,
      {
        code: code,
        type: type,
      },
      req,
    );
  } catch {
    return fail(new Unauthorized('Two-factor authentication code failed. Please try again'));
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
