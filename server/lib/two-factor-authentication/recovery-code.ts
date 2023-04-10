import { ApolloError } from '../../graphql/errors';
import User from '../../models/User';
import { crypto } from '../encryption';

import { Token } from './lib';

export default {
  async validateToken(user: User, token: Token): Promise<void> {
    const verified = verifyTwoFactorAuthenticationRecoveryCode(user.twoFactorAuthRecoveryCodes, token.code);

    if (!verified) {
      throw new ApolloError('Two-factor authentication code is invalid', 'INVALID_2FA_CODE');
    }

    // reset user 2fa after use.
    await user.update({ twoFactorAuthRecoveryCodes: null, twoFactorAuthToken: null, yubikeyDeviceId: null });
  },
};

/**
 * Verifies a user's submitted recovery code against the hashed ones saved for them in the DB.
 * Returns true or false for whether the code is valid or not.
 */
function verifyTwoFactorAuthenticationRecoveryCode(hashedRecoveryCodes, recoveryCode) {
  return hashedRecoveryCodes.includes(crypto.hash(recoveryCode.toUpperCase()));
}
