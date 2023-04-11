import crypto from 'crypto';

import { ApolloError } from 'apollo-server-express';

import User from '../../models/User';
import UserTwoFactorMethod from '../../models/UserTwoFactorMethod';

import { Token, TwoFactorMethod } from './lib';

export default {
  async validateToken(user: User, token: Token): Promise<void> {
    if (token.code.length !== 44) {
      throw new ApolloError('Two-factor authentication code is invalid', 'INVALID_2FA_CODE');
    }

    const tokenDeviceId = token.code.substring(0, 12);
    const userYubikeyOTPMethods = await UserTwoFactorMethod.findAll<UserTwoFactorMethod<TwoFactorMethod.YUBIKEY_OTP>>({
      where: {
        UserId: user.id,
        method: TwoFactorMethod.YUBIKEY_OTP,
        data: {
          yubikeyDeviceId: tokenDeviceId,
        },
      },
    });

    if (!userYubikeyOTPMethods || userYubikeyOTPMethods.length === 0) {
      throw new Error('User is not configured with YubiKey OTP 2FA');
    }

    const valid = validateYubikeyOTP(token.code);
    if (!valid) {
      throw new ApolloError('Two-factor authentication code is invalid', 'INVALID_2FA_CODE');
    }
  },
};

export async function validateYubikeyOTP(otp: string): Promise<boolean> {
  const response = await fetch(
    `https://api2.yubico.com/wsapi/2.0/verify?${new URLSearchParams({
      otp,
      nonce: crypto.randomBytes(16).toString('base64'),
    }).toString()}`,
    { method: 'GET' },
  );
  const validationResponse = await response.text();
  return validationResponse.indexOf('status=OK') !== -1;
}
