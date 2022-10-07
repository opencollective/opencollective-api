import { crypto } from '../encryption';

import twoFactorAuthLib from './lib';

export { SupportedTwoFactorMethods, Token, TwoFactorAuthProvider, TwoFactorMethod } from './lib';

export default twoFactorAuthLib;

/**
 * Verifies a user's submitted recovery code against the hashed ones saved for them in the DB.
 * Returns true or false for whether the code is valid or not.
 */
export function verifyTwoFactorAuthenticationRecoveryCode(hashedRecoveryCodes, recoveryCode) {
  return hashedRecoveryCodes.includes(crypto.hash(recoveryCode.toUpperCase()));
}
