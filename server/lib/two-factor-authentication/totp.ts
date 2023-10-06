import speakeasy from 'speakeasy';

import { ApolloError } from '../../graphql/errors';
import User from '../../models/User';
import UserTwoFactorMethod from '../../models/UserTwoFactorMethod';
import { crypto } from '../encryption';

import { Token, TwoFactorMethod } from './lib';

export default {
  async validateToken(user: User, token: Token): Promise<void> {
    const userTotpMethods = await UserTwoFactorMethod.findAll<UserTwoFactorMethod<TwoFactorMethod.TOTP>>({
      where: {
        UserId: user.id,
        method: TwoFactorMethod.TOTP,
      },
    });

    if (!userTotpMethods || userTotpMethods.length === 0) {
      throw new Error('User is not configured with TOPT 2FA');
    }

    for (const totpMethod of userTotpMethods) {
      const valid = validateTOTPToken(totpMethod.data.secret, token.code);
      if (valid) {
        return;
      }
    }

    throw new ApolloError('Two-factor authentication code is invalid', 'INVALID_2FA_CODE');
  },
};

/**
 * Verifies a TOTP against a user's 2FA token saved in the DB
 * encryptedTwoFactorAuthToken = token saved for a User in the DB
 * twoFactorAuthenticatorCode = 6-digit TOTP
 */
export function validateTOTPToken(encryptedSecret: string, token: string): boolean {
  const decryptedTwoFactorAuthToken = crypto.decrypt(encryptedSecret);
  return speakeasy.totp.verify({
    secret: decryptedTwoFactorAuthToken,
    encoding: 'base32',
    token: token,
    window: 2,
  });
}
