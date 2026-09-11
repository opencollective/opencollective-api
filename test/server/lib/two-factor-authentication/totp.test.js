import { expect } from 'chai';
import { generateSecret, generateSync } from 'otplib';

import { crypto } from '../../../../server/lib/encryption';
import totpProvider from '../../../../server/lib/two-factor-authentication/totp';
import { fakeUser } from '../../../test-helpers/fake-data';

describe('lib/two-factor-authentication', () => {
  describe('totp', () => {
    it('fails if user is not configured with 2FA', async () => {
      const user = await fakeUser();
      const token = {};

      await expect(totpProvider.validateToken(user, token)).to.be.eventually.rejectedWith(
        Error,
        'User is not configured with TOPT 2FA',
      );
    });

    it('fails if user token is incorrect', async () => {
      const secret = generateSecret({ length: 64 });
      const encryptedToken = crypto.encrypt(secret);

      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });
      const token = {};

      await expect(totpProvider.validateToken(user, token)).to.be.eventually.rejectedWith(
        Error,
        'Two-factor authentication code is invalid',
      );
    });

    it('succeeds if user token is correct', async () => {
      const secret = generateSecret({ length: 64 });
      const encryptedToken = crypto.encrypt(secret);

      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });

      const twoFactorAuthenticatorCode = generateSync({ secret, algorithm: 'sha1', strategy: 'totp' });

      const token = {
        code: twoFactorAuthenticatorCode,
      };

      await expect(totpProvider.validateToken(user, token)).to.be.eventually.fulfilled;
    });
  });
});
