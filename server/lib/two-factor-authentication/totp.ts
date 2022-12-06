import { ApolloError } from 'apollo-server-express';
import speakeasy from 'speakeasy';

import User from '../../models/User';
import { crypto } from '../encryption';

import { Token } from './lib';

export default {
  async validateToken(user: User, token: Token): Promise<void> {
    if (!user.twoFactorAuthToken) {
      throw new Error('User is not configured with TOPT 2FA');
    }

    const valid = validateTOTPToken(user.twoFactorAuthToken, token.code);
    if (!valid) {
      throw new ApolloError('Two-factor authentication code is invalid', 'INVALID_2FA_CODE');
    }
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
