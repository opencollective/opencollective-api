import { Request } from 'express';

import { OAuthScope } from '../constants/oauth-scopes';
import { enforceScope } from '../graphql/common/scope-check';
import { Forbidden, Unauthorized } from '../graphql/errors';
import models from '../models';

import twoFactorAuthLib from './two-factor-authentication';

export enum TwoFactorAuthenticationPolicies {
  /**
   * 2FA will only be requested upon sign-in, not when using the feature. If the account has the
   * `REQUIRE_2FA_FOR_ADMINS` policy, then 2FA will be required for admins of this account.
   */
  SOFT = 'SOFT',
  /**
   * 2FA will be required for the current session. Users will have to revalidate it once in a while.
   */
  SESSION = 'SESSION',
  /**
   * If enabled, a new 2FA code will have to be passed with each request
   */
  ALWAYS_ASK = 'ALWAYS_ASK',
}

type TwoFactorAuthenticationPolicy = keyof typeof TwoFactorAuthenticationPolicies;

type ValidateRequestOptions = {
  mustBeLoggedIn: boolean;
  twoFactorAuthentication?: TwoFactorAuthenticationPolicies | TwoFactorAuthenticationPolicy;
  // User will have to be an admin of one of these accounts
  mustBeAdminOf?: typeof models.Collective | typeof models.Collective[];
  oauthScope?: OAuthScope | OAuthScope[];
};

const getValidateTwoFactorAuthenticationOptions = (options: ValidateRequestOptions) => {
  switch (options.twoFactorAuthentication) {
    case 'SOFT':
      return { alwaysAskForToken: false, neverAskForToken: true };
    case 'SESSION':
      return { alwaysAskForToken: false };
    case 'ALWAYS_ASK':
      return { alwaysAskForToken: true };
  }
};

const PermissionsLib = {
  validateRequest: async (req: Request, options: ValidateRequestOptions): Promise<void> => {
    if (options.mustBeLoggedIn && !req.remoteUser) {
      throw new Unauthorized();
    }

    if (options.mustBeAdminOf) {
      const accounts = Array.isArray(options.mustBeAdminOf) ? options.mustBeAdminOf : [options.mustBeAdminOf];
      const isAdmin = accounts.some(account => req.remoteUser?.isAdminOfCollective(account));
      if (!isAdmin) {
        throw new Forbidden(`You must be an admin of ${options.mustBeAdminOf.slug}`);
      }
    }

    if (options.oauthScope) {
      const scopes = Array.isArray(options.oauthScope) ? options.oauthScope : [options.oauthScope];
      scopes.forEach(scope => enforceScope(req, scope));
    }

    if (
      req.remoteUser &&
      options.twoFactorAuthentication &&
      // Always check 2FA if enabled on the user account
      (twoFactorAuthLib.userHasTwoFactorAuthEnabled(req.remoteUser) ||
        // Or if one of the accounts user is admins of has the `REQUIRE_2FA_FOR_ADMINS` policy
        (options.mustBeAdminOf && (await twoFactorAuthLib.shouldEnforceForAccount(req, options.mustBeAdminOf))))
    ) {
      const twoFactorAuthOptions = getValidateTwoFactorAuthenticationOptions(options);
      await twoFactorAuthLib.validateRequest(req, twoFactorAuthOptions);
    }
  },
};

export default PermissionsLib;
