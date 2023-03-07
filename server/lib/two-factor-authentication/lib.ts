import { ApolloError } from 'apollo-server-errors';
import { Request } from 'express';
import { isNil } from 'lodash';

import POLICIES from '../../constants/policies';
import { Unauthorized } from '../../graphql/errors';
import models from '../../models';
import User from '../../models/User';
import cache from '../cache';
import { hasPolicy } from '../policies';

import totp from './totp';

const DEFAULT_TWO_FACTOR_AUTH_SESSION_DURATION = 24 * 60 * 60; // 24 hour

type ValidateRequestOptions = {
  // require user configured 2FA
  requireTwoFactorAuthEnabled?: boolean;
  // always ask for a token when using 2FA
  alwaysAskForToken?: boolean;
  // if true, will only check if the user has 2FA enabled (which means it's been validated on sign in)
  onlyAskOnLogin?: boolean;
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
  validateToken(user: User, token: Token): Promise<void>;
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

async function validateToken(user: User, token: Token): Promise<void> {
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

function getSessionKey(req: Request, options: ValidateRequestOptions): string {
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

/**
 * Validates 2FA for user making the request (`req`). Throws if 2FA is required but not provided.
 * @returns true if 2FA was validated, false if not required
 */
async function validateRequest(
  req: Request,
  options: ValidateRequestOptions = DefaultValidateRequestOptions,
): Promise<boolean> {
  options = { ...DefaultValidateRequestOptions, ...options };

  if (!req.remoteUser) {
    throw new Unauthorized();
  }

  const remoteUser = req.remoteUser;

  const userHasTwoFactorAuth = userHasTwoFactorAuthEnabled(remoteUser);
  if (options.requireTwoFactorAuthEnabled && !userHasTwoFactorAuth) {
    throw new ApolloError('Two factor authentication must be configured', '2FA_REQUIRED');
  }

  if (!userHasTwoFactorAuth || options.onlyAskOnLogin) {
    return false;
  }

  if (!options.alwaysAskForToken) {
    if (await hasValidTwoFactorSession(req, options)) {
      return true;
    }
  }

  const token = getTwoFactorAuthTokenFromRequest(req);
  if (!token) {
    throw new ApolloError('Two-factor authentication required', '2FA_REQUIRED', {
      supportedMethods: twoFactorMethodsSupportedByUser(req.remoteUser),
    });
  }

  await validateToken(remoteUser, token);

  await storeTwoFactorSession(req, options);

  return true;
}

function twoFactorMethodsSupportedByUser(remoteUser: User): TwoFactorMethod[] {
  const methods = [];
  if (remoteUser.twoFactorAuthToken) {
    methods.push(TwoFactorMethod.TOTP);
  }

  return methods;
}

function userHasTwoFactorAuthEnabled(user: User) {
  return Boolean(user.twoFactorAuthToken);
}

/**
 * Returns true if this request / account should enforce 2FA.
 * The parent account, if any, is always the source of truth
 */
async function shouldEnforceForAccount(req, account?: typeof models.Collective): Promise<boolean> {
  return await hasPolicy(account, POLICIES.REQUIRE_2FA_FOR_ADMINS);
}

/**
 * Enforce 2FA if enabled on `account` and this account has the `REQUIRE_2FA_FOR_ADMINS policy` set on itself or its parent.
 *
 * Otherwise, this function will still check for 2FA for root users or if it's already enabled on the user account.
 *
 * @returns true if 2FA was validated, false if not required
 */
async function enforceForAccount(
  req: Request,
  account: typeof models.Collective,
  options: Omit<ValidateRequestOptions, 'requireTwoFactorAuthEnabled'> = undefined,
): Promise<boolean | undefined> {
  if (!req.remoteUser) {
    return false; // Never enforce 2FA if there's no logged in user
  }

  // See if we need to enforce 2FA for admins of this account
  if (userHasTwoFactorAuthEnabled(req.remoteUser) || (await shouldEnforceForAccount(req, account))) {
    return validateRequest(req, { ...options, requireTwoFactorAuthEnabled: true });
  }
}

/**
 * Enforces 2FA with `enforceForAccount` for accounts user is admin of. Stops as soon as a 2FA verification succeeds.
 *
 * @returns true if 2FA was validated, false if not required
 */
async function enforceForAccountsUserIsAdminOf(
  req: Request,
  accounts: typeof models.Collective | Array<typeof models.Collective>,
  options: Omit<ValidateRequestOptions, 'requireTwoFactorAuthEnabled'> = undefined,
): Promise<boolean | undefined> {
  accounts = Array.isArray(accounts) ? accounts : [accounts];
  for (const account of accounts) {
    if (req.remoteUser?.isAdminOfCollective(account)) {
      const result = await enforceForAccount(req, account, options);
      if (result) {
        return true;
      }
    }
  }

  return false;
}

const twoFactorAuthLib = {
  validateRequest,
  enforceForAccount,
  enforceForAccountsUserIsAdminOf,
  validateToken,
  getTwoFactorAuthTokenFromRequest,
  userHasTwoFactorAuthEnabled,
};

export default twoFactorAuthLib;
