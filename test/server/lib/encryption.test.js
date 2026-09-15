import { expect } from 'chai';

import { generateKey, secretbox, timingSafeEqualString } from '../../../server/lib/encryption';

describe('server/lib/encryption', () => {
  describe('secretbox', () => {
    it('it encrypts and decrypts ok', () => {
      const message = 'OpenCollective Rules';
      const buff = Buffer.from(message);
      const key = generateKey();

      const encrypted = secretbox.encrypt(buff, key);

      expect(Buffer.isBuffer(encrypted)).to.be.true;

      expect(encrypted).to.not.eq(message);

      const result = secretbox.decrypt(encrypted, key);

      expect(result).to.eq(message);
    });
  });

  describe('timingSafeEqualString', () => {
    it('returns true for matching strings', () => {
      expect(timingSafeEqualString('secret-value', 'secret-value')).to.be.true;
    });

    it('returns false for different strings', () => {
      expect(timingSafeEqualString('secret-value', 'other-value')).to.be.false;
    });

    it('returns false for null or non-strings', () => {
      expect(timingSafeEqualString(null, 'secret-value')).to.be.false;
      expect(timingSafeEqualString('secret-value', undefined)).to.be.false;
      expect(timingSafeEqualString(undefined, undefined)).to.be.false;
    });
  });
});
