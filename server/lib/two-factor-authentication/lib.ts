import { ApolloError } from 'apollo-server-errors';
import { Request } from 'express';
import { isNil } from 'lodash';

import { Unauthorized } from '../../graphql/errors';
import User from '../../models/User';
import cache from '../cache';

import totp from './totp';

const DEFAULT_TWO_FACTOR_AUTH_SESSION_DURATION = 600; // 10min

type ValidateRequestOptions = {
  // require user configured 2FA
  requireTwoFactorAuthEnabled?: boolean;
  // always ask for a token when using 2FA
  alwaysAskForToken?: boolean;
  // duration which we wont require a token after a successful use
  sessionDuration?: number;
  // identifier for the session, defaults to use the JWT token's session key
  sessionKey?: (() => string) | string;
};

export enum TwoFactorMethod {
  TOTP = 'totp',
}

export const TwoFactorAuthenticationHeader = 'x-two-factor-authentication';

export const SupportedTwoFactorMethods = [TwoFactorMethod.TOTP];

export type Token = {
  type: TwoFactorMethod;
  code: string;
};

export interface TwoFactorAuthProvider {
  validateToken(user: typeof User, token: Token): Promise<void>;
}

export const providers: { [method in TwoFactorMethod]: TwoFactorAuthProvider } = {
  [TwoFactorMethod.TOTP]: totp,
};

function getTwoFactorAuthTokenFromRequest(req: Request): Token {
  const header = req.get(TwoFactorAuthenticationHeader);
  if (!header) {
    return null;
  }

  const parts = header.split(' ');
  const type = parts[0] as TwoFactorMethod;
  const code = parts[1];

  if (!type || !code) {
    throw new Error('Malformed 2FA token header');
  }

  return {
    type,
    code,
  };
}

async function validateToken(user: typeof User, token: Token): Promise<void> {
  if (!SupportedTwoFactorMethods.includes(token.type)) {
    throw new Error(`Unsupported 2FA type ${token.type}`);
  }

  return providers[token.type].validateToken(user, token);
}

const DefaultValidateRequestOptions: ValidateRequestOptions = {
  requireTwoFactorAuthEnabled: false,
  alwaysAskForToken: false,
  sessionDuration: DEFAULT_TWO_FACTOR_AUTH_SESSION_DURATION,
};

function getSessionKey(req: Request, options: ValidateRequestOptions) {
  const userId = req.remoteUser.id;
  if (typeof options.sessionKey === 'function') {
    return `2fa:${userId}:${options.sessionKey()}`;
  } else if (typeof options.sessionKey === 'string') {
    return `2fa:${userId}:${options.sessionKey}`;
  } else {
    const sessionId = req.jwtPayload?.sessionId;
    return `2fa:${userId}:${sessionId}`;
  }
}

async function hasValidTwoFactorSession(
  req: Request,
  options: ValidateRequestOptions = DefaultValidateRequestOptions,
): Promise<boolean> {
  const sessionKey = getSessionKey(req, options);

  const twoFactorSession = await cache.get(sessionKey);

  if (isNil(twoFactorSession)) {
    return false;
  }

  return true;
}

async function storeTwoFactorSession(
  req: Request,
  options: ValidateRequestOptions = DefaultValidateRequestOptions,
): Promise<void> {
  const sessionKey = getSessionKey(req, options);
  return cache.set(sessionKey, {}, options.sessionDuration);
}

async function validateRequest(
  req: Request,
  options: ValidateRequestOptions = DefaultValidateRequestOptions,
): Promise<void> {
  options = { ...DefaultValidateRequestOptions, ...options };

  if (!req.remoteUser) {
    throw new Unauthorized();
  }

  const remoteUser = req.remoteUser;

  const userHasTwoFactorAuth = await userHasTwoFactorAuthEnabled(remoteUser);
  if (options.requireTwoFactorAuthEnabled && !userHasTwoFactorAuth) {
    throw new ApolloError('Two factor authentication must be configured', '2FA_REQUIRED');
  }

  if (!userHasTwoFactorAuth) {
    return;
  }

  if (!options.alwaysAskForToken) {
    if (await hasValidTwoFactorSession(req, options)) {
      return;
    }
  }

  const token = getTwoFactorAuthTokenFromRequest(req);
  if (!token) {
    throw new ApolloError('Two-factor authentication required', '2FA_REQUIRED', {
      supportedMethods: twoFactorMethodsSupportedByUser(req.remoteUser),
    });
  }

  await validateToken(remoteUser, token);

  return storeTwoFactorSession(req, options);
}

function twoFactorMethodsSupportedByUser(remoteUser: typeof User): TwoFactorMethod[] {
  const methods = [];
  if (remoteUser.twoFactorAuthToken) {
    methods.push(TwoFactorMethod.TOTP);
  }

  return methods;
}

async function userHasTwoFactorAuthEnabled(user: typeof User) {
  if (user.twoFactorAuthToken) {
    return true;
  }

  return false;
}

const twoFactorAuthLib = {
  validateRequest,
  validateToken,
  getTwoFactorAuthTokenFromRequest,
  userHasTwoFactorAuthEnabled,
};

export default twoFactorAuthLib;
