import { Request } from 'express';
import { isNil, pick } from 'lodash';

import { activities } from '../../constants';
import POLICIES from '../../constants/policies';
import { ApolloError, Unauthorized } from '../../graphql/errors';
import { Activity, Collective, User, UserTwoFactorMethod } from '../../models';
import { sessionCache } from '../cache';
import { hasPolicy } from '../policies';

import recoveryCode from './recovery-code';
import totp from './totp';
import { TwoFactorMethod } from './two-factor-methods';
import * as webauthn from './webauthn';
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
  // duration which we wont require a token after a successful use, in seconds
  sessionDuration?: number;
  // identifier for the session, defaults to use the JWT token's session key
  sessionKey?: (() => string) | string;
  // to document which account requested the 2FA token. Defaults to the user's account
  FromCollectiveId?: number;
  // Some additional data to be stored in the activity
  customData?: Record<string, unknown>;
};

/**
 * Some default session params
 */
export const TWO_FACTOR_SESSIONS_PARAMS = {
  MANAGE_PERSONAL_TOKENS: { sessionKey: 'personal-tokens', sessionDuration: 5 * 60 }, // 5 minutes
};

export const TwoFactorAuthenticationHeader = 'x-two-factor-authentication';

const SupportedTwoFactorMethods = [
  TwoFactorMethod.TOTP,
  TwoFactorMethod.YUBIKEY_OTP,
  TwoFactorMethod.RECOVERY_CODE,
  TwoFactorMethod.WEBAUTHN,
];

export type Token = {
  type: TwoFactorMethod;
  code: string;
};

interface TwoFactorAuthProvider {
  validateToken(user: User, token: Token, req?): Promise<void>;
  authenticationOptions?(user: User, req): Promise<unknown>;
}

const providers: { [method in TwoFactorMethod]: TwoFactorAuthProvider } = {
  [TwoFactorMethod.TOTP]: totp,
  [TwoFactorMethod.YUBIKEY_OTP]: yubikeyOTP,
  [TwoFactorMethod.RECOVERY_CODE]: recoveryCode,
  [TwoFactorMethod.WEBAUTHN]: webauthn,
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

async function validateToken(user: User, token: Token, req): Promise<void> {
  if (!SupportedTwoFactorMethods.includes(token.type)) {
    throw new Error(`Unsupported 2FA type ${token.type}`);
  }

  return providers[token.type].validateToken(user, token, req);
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

  const twoFactorSession = await sessionCache.get(sessionKey);

  if (isNil(twoFactorSession)) {
    return false;
  }

  return true;
}

async function storeTwoFactorSession(req: Request, options: ValidateRequestOptions = DefaultValidateRequestOptions) {
  const sessionKey = getSessionKey(req, options);
  return sessionCache.set(sessionKey, {}, options.sessionDuration);
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

  // Allow Personal Tokens and OAuth tokens to bypass 2FA check if they have been pre-authorized
  if (req.userToken || req.personalToken) {
    if (req.personalToken?.preAuthorize2FA || req.userToken?.preAuthorize2FA) {
      return true;
    } else {
      const type = req.personalToken ? 'personal' : 'OAuth';
      throw new Error(`This ${type} token is not pre-authorized for 2FA`);
    }
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

    const supportedMethods = await twoFactorMethodsSupportedByUser(remoteUser);
    const authenticationOptions: Partial<Record<TwoFactorMethod, unknown>> = {};
    for (const method of supportedMethods) {
      if (providers[method].authenticationOptions) {
        authenticationOptions[method] = await providers[method].authenticationOptions(remoteUser, req);
      }
    }

    throw new ApolloError('Two-factor authentication required', '2FA_REQUIRED', {
      supportedMethods,
      authenticationOptions,
    });
  } else if (req.userToken || req.clientApp) {
    // 2FA tokens should not be used with personal tokens or OAuth tokens
    console.warn(`2FA token used with personal token or OAuth token`, {
      userToken: req.userToken?.id,
      clientApp: req.clientApp?.id,
      url: req.url,
    });
  }

  await validateToken(remoteUser, token, req);

  await storeTwoFactorSession(req, options);

  return true;
}

async function twoFactorMethodsSupportedByUser(remoteUser: User): Promise<TwoFactorMethod[]> {
  const methods = await UserTwoFactorMethod.userMethods(remoteUser.id);
  if (methods.length > 0) {
    methods.push(TwoFactorMethod.RECOVERY_CODE);
  }
  return methods;
}

async function userHasTwoFactorAuthEnabled(user: User) {
  const methods = await UserTwoFactorMethod.userMethods(user.id);
  return methods.length !== 0;
}
/**
 * Returns true if this request / account should enforce 2FA.
 * The parent account, if any, is always the source of truth
 */
async function shouldEnforceForAccount(account?: Collective): Promise<boolean> {
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
  if ((await userHasTwoFactorAuthEnabled(req.remoteUser)) || (await shouldEnforceForAccount(account))) {
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
