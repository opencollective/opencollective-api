import { Request } from 'express';
import { isNil, pick } from 'lodash';

import { activities } from '../../constants';
import POLICIES from '../../constants/policies';
import { ApolloError, Unauthorized } from '../../graphql/errors';
import { Activity, Collective } from '../../models';
import User from '../../models/User';
import UserTwoFactorMethod from '../../models/UserTwoFactorMethod';
import cache from '../cache';
import { hasPolicy } from '../policies';

import recoveryCode from './recovery-code';
import totp from './totp';
import { TwoFactorMethod } from './two-factor-methods';
import yubikeyOTP from './yubikey-otp';

export { TwoFactorMethod };

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
  // to document which account requested the 2FA token. Defaults to the user's account
  FromCollectiveId?: number;
  // Some additional data to be stored in the activity
  customData?: Record<string, unknown>;
};

export const TwoFactorAuthenticationHeader = 'x-two-factor-authentication';

export const SupportedTwoFactorMethods = [
  TwoFactorMethod.TOTP,
  TwoFactorMethod.YUBIKEY_OTP,
  TwoFactorMethod.RECOVERY_CODE,
];

export type Token = {
  type: TwoFactorMethod;
  code: string;
};

export interface TwoFactorAuthProvider {
  validateToken(user: User, token: Token): Promise<void>;
}

export const providers: { [method in TwoFactorMethod]: TwoFactorAuthProvider } = {
  [TwoFactorMethod.TOTP]: totp,
  [TwoFactorMethod.YUBIKEY_OTP]: yubikeyOTP,
  [TwoFactorMethod.RECOVERY_CODE]: recoveryCode,
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

async function storeTwoFactorSession(req: Request, options: ValidateRequestOptions = DefaultValidateRequestOptions) {
  const sessionKey = getSessionKey(req, options);
  return cache.set(sessionKey, {}, options.sessionDuration);
}

function inferContextFromRequest(req: Request) {
  if (req.isGraphQL && req.body) {
    const operation = req.body.operationName || 'Request';
    return `GraphQL: ${operation}`;
  }

  return 'default';
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

  const userHasTwoFactorAuth = await userHasTwoFactorAuthEnabled(remoteUser);
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

  // If there's no OAuth token, throw an error that will ask the user to provide one and document
  // the request through an entry in the `Activities` table.
  if (!token) {
    Activity.create({
      type: activities.TWO_FACTOR_CODE_REQUESTED,
      UserId: remoteUser.id,
      CollectiveId: remoteUser.CollectiveId,
      FromCollectiveId: options.FromCollectiveId || remoteUser.CollectiveId,
      UserTokenId: req.userToken?.id,
      data: {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        context: inferContextFromRequest(req),
        ...pick(options, ['alwaysAskForToken', 'sessionDuration', 'customData']),
      },
    });

    throw new ApolloError('Two-factor authentication required', '2FA_REQUIRED', {
      supportedMethods: await twoFactorMethodsSupportedByUser(req.remoteUser),
    });
  }

  await validateToken(remoteUser, token);

  await storeTwoFactorSession(req, options);

  return true;
}

async function twoFactorMethodsSupportedByUser(remoteUser: User): Promise<TwoFactorMethod[]> {
  return await UserTwoFactorMethod.userMethods(remoteUser.id);
}

async function userHasTwoFactorAuthEnabled(user: User) {
  const methods = await UserTwoFactorMethod.userMethods(user.id);
  return methods.length !== 0;
}
/**
 * Returns true if this request / account should enforce 2FA.
 * The parent account, if any, is always the source of truth
 */
async function shouldEnforceForAccount(req, account?: Collective): Promise<boolean> {
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
  account: Collective,
  options: Omit<ValidateRequestOptions, 'requireTwoFactorAuthEnabled'> = undefined,
): Promise<boolean | undefined> {
  if (!req.remoteUser) {
    return false; // Never enforce 2FA if there's no logged in user
  }

  // See if we need to enforce 2FA for admins of this account
  if ((await userHasTwoFactorAuthEnabled(req.remoteUser)) || (await shouldEnforceForAccount(req, account))) {
    return validateRequest(req, { ...options, requireTwoFactorAuthEnabled: true, FromCollectiveId: account.id });
  }
}

/**
 * Enforces 2FA with `enforceForAccount` for accounts user is admin of. Stops as soon as a 2FA verification succeeds.
 *
 * @returns true if 2FA was validated, false if not required
 */
async function enforceForAccountsUserIsAdminOf(
  req: Request,
  accounts: Collective | Array<Collective>,
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
  twoFactorMethodsSupportedByUser,
};

export default twoFactorAuthLib;
