import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import speakeasy from 'speakeasy';

import totpProvider from '../../../../server/lib/two-factor-authentication/totp.js';
import { fakeUser } from '../../../test-helpers/fake-data.js';

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

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
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();

      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });
      const token = {};

      await expect(totpProvider.validateToken(user, token)).to.be.eventually.rejectedWith(
        Error,
        'Two-factor authentication code is invalid',
      );
    });

    it('succeeds if user token is correct', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();

      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });

      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });

      const token = {
        code: twoFactorAuthenticatorCode,
      };

      await expect(totpProvider.validateToken(user, token)).to.be.eventually.fulfilled;
    });
  });
});
