import { expect } from 'chai';
import config from 'config';
import nacl from 'tweetnacl';

import { crypto, decryptWithCipher, encryptWithCipher, generateKey, secretbox } from '../../../server/lib/encryption';

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

    it('generates base64-encoded keys of the expected length', () => {
      const key = generateKey();
      expect(Buffer.from(key, 'base64').toString('base64')).to.eq(key);
      expect(Buffer.from(key, 'base64')).to.have.length(nacl.secretbox.keyLength);
    });

    it('produces payloads in the `nonce || box` format', () => {
      const key = generateKey();
      const message = Buffer.from('OpenCollective Rules');
      const encrypted = secretbox.encrypt(message, key);

      const { nonceLength, overheadLength } = nacl.secretbox;
      expect(encrypted).to.have.length(nonceLength + overheadLength + message.length);
      const decrypted = nacl.secretbox.open(
        new Uint8Array(encrypted.subarray(nonceLength)),
        new Uint8Array(encrypted.subarray(0, nonceLength)),
        new Uint8Array(Buffer.from(key, 'base64')),
      );
      expect(Buffer.from(decrypted).equals(message)).to.be.true;
    });

    it('fails to decrypt with the wrong key', () => {
      const encrypted = secretbox.encrypt(Buffer.from('OpenCollective Rules'), generateKey());
      expect(() => secretbox.decrypt(encrypted, generateKey())).to.throw('Could not decrypt message');
      expect(() => secretbox.decryptRaw(encrypted, generateKey())).to.throw('Could not decrypt message');
    });

    // These payloads were generated with tweetnacl@1.0.3 + tweetnacl-util@0.15.1, which we used before
    // switching to the native Buffer/crypto helpers. They must keep decrypting properly, since the tax
    // form PDFs in S3 and `LegalDocuments.data.encryptedFormData` are stored in this format.
    describe('decrypts legacy tweetnacl-util payloads', () => {
      const key = 'tWWsqPgkOVcMYYuPYXQm+LiFF9PaBN14ySGV1HNuYPs=';

      it('decrypts a text payload', () => {
        const encrypted = Buffer.from(
          'iaqj99iS06bhBJcl5i2XOqsUA6afR7yp1ykJvNh5FKd/w8No/IT9HlCz15f9V7ERpPIGRrY199j763kk',
          'base64',
        );
        expect(secretbox.decrypt(encrypted, key)).to.eq('OpenCollective Rules');
      });

      it('decrypts an `encryptedFormData` payload', () => {
        const encryptedFormData =
          'P9HhWJcoB3mwTp7/8v6kvru2NgquhZJbHy+UtuYDNBAsgfiU0XKZooleoZxSJxSsNmG/NIXmaWfNKye6qWSewt8MOWn1slxQd0tlfR58XIDaN7pTHw==';
        const decrypted = secretbox.decryptRaw(Buffer.from(encryptedFormData, 'base64'), key);
        expect(JSON.parse(decrypted.toString())).to.deep.eq({ formType: 'W9', name: 'José Müller 🎉' });
      });

      it('decrypts a binary payload byte for byte', () => {
        const encrypted = Buffer.from('SB2cmzu/rHLY8GoGdtVo2w/HZnoEreahYUr4YBmW+30g7QxZSUPjM+2kLMDrLBtBsD0=', 'base64');
        expect(secretbox.decryptRaw(encrypted, key).toString('hex')).to.eq('255044462dfffe00800a');
      });
    });
  });

  describe('crypto', () => {
    describe('hash', () => {
      it('returns the hex-encoded SHA256 of the message', () => {
        expect(crypto.hash('')).to.eq('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(crypto.hash('OpenCollective Rules')).to.eq(
          '0f7ca7b3b8a12812284c6d448971259e7a0d8dbe16e507551221fe95c7963c74',
        );
      });

      it('is stable across calls', () => {
        expect(crypto.hash('OpenCollective Rules')).to.eq(crypto.hash('OpenCollective Rules'));
      });
    });

    describe('encrypt/decrypt', () => {
      it('encrypts and decrypts with the configured cipher', () => {
        const message = 'OpenCollective Rules';
        const encrypted = crypto.encrypt(message);

        expect(encrypted).to.not.eq(message);
        expect(crypto.decrypt(encrypted)).to.eq(message);
      });

      it('uses a random salt, so the same message never produces the same payload', () => {
        const message = 'OpenCollective Rules';
        expect(crypto.encrypt(message)).to.not.eq(crypto.encrypt(message));
      });

      it('supports unicode', () => {
        const message = 'héllo wörld 🎉';
        expect(crypto.decrypt(crypto.encrypt(message))).to.eq(message);
      });

      it('throws when the payload is not a valid encrypted message', () => {
        expect(() => crypto.decrypt('not-encrypted')).to.throw('Could not decrypt message: invalid payload');
      });

      it('throws when the payload is not canonical base64', () => {
        // Buffer.from ignores characters that are not valid base64, so without an explicit check
        // these would all decrypt as if the payload had never been corrupted.
        const encrypted = crypto.encrypt('A simple message');
        for (const corrupted of [
          `${encrypted}!!!`,
          `${encrypted}\n`,
          `${encrypted} `,
          `${encrypted.slice(0, 20)}!${encrypted.slice(20)}`,
        ]) {
          expect(() => crypto.decrypt(corrupted)).to.throw('Could not decrypt message: invalid payload');
        }
      });

      it('returns an empty string for empty payloads', () => {
        expect(crypto.decrypt('')).to.eq('');
        expect(crypto.decrypt(null)).to.eq('');
      });
    });
  });

  describe('encryptWithCipher/decryptWithCipher', () => {
    const SECRET_KEY = 'guineapigs';

    for (const cipher of ['AES', 'DES', 'TripleDES']) {
      it(`round-trips with ${cipher}`, () => {
        const message = 'OpenCollective Rules';
        const encrypted = encryptWithCipher(message, SECRET_KEY, cipher);

        expect(encrypted).to.not.eq(message);
        expect(decryptWithCipher(encrypted, SECRET_KEY, cipher)).to.eq(message);
      });
    }

    it('throws on unsupported ciphers', () => {
      expect(() => encryptWithCipher('Hello', SECRET_KEY, 'RC4')).to.throw('Unsupported cipher: RC4');
      expect(() => decryptWithCipher('Hello', SECRET_KEY, 'RC4')).to.throw('Unsupported cipher: RC4');
    });

    it('fails to decrypt with the wrong key', () => {
      const encrypted = encryptWithCipher('OpenCollective Rules', SECRET_KEY, 'AES');
      expect(() => decryptWithCipher(encrypted, 'wrong-key', 'AES')).to.throw();
    });

    // These payloads were generated with crypto-js@4.2.0, which we used before switching to the
    // native NodeJS crypto module. They must keep decrypting properly, since the database still
    // holds values encrypted with the legacy implementation.
    describe('decrypts legacy crypto-js payloads', () => {
      const legacyPayloads = [
        {
          cipher: 'DES',
          message: 'A simple message',
          encrypted: 'U2FsdGVkX18SdtG4c5XHqo7VpjCI7fiR4mud/1ITfLxJaSTt962zCg==',
        },
        {
          cipher: 'AES',
          message: 'A simple message',
          encrypted: 'U2FsdGVkX191cIdHle13fQsIWtDRju07/AfWydD6lxd2cTL1Jw0y/1hceu8OCOkm',
        },
        {
          cipher: 'TripleDES',
          message: 'A simple message',
          encrypted: 'U2FsdGVkX1+nOrWNK1FL8SH1HCO8N5+HBJKquOH4NndAgUDHmK9tIg==',
        },
        {
          cipher: 'DES',
          message: 'héllo wörld 🎉',
          encrypted: 'U2FsdGVkX1+Bolv+7z8LIjtCCVQnG5Fy+EHJOehPTsVQhP3Btrhprg==',
        },
        {
          cipher: 'AES',
          message: '{"cvv":"123","number":"4242424242424242"}',
          encrypted: 'U2FsdGVkX1/LVaNEPoTogvz2Uc6oM1y1fulB/8O5EqpbQ6XwolXb5UOPfpxs0S5NZMvJZ3Zjha7i6QtUiqvp5w==',
        },
      ];

      for (const { cipher, message, encrypted } of legacyPayloads) {
        it(`${cipher}: ${message}`, () => {
          expect(decryptWithCipher(encrypted, SECRET_KEY, cipher)).to.eq(message);
        });
      }
    });

    it('produces payloads in the OpenSSL "enc" format', () => {
      const encrypted = encryptWithCipher('OpenCollective Rules', SECRET_KEY, config.dbEncryption.cipher);
      expect(Buffer.from(encrypted, 'base64').subarray(0, 8).toString('utf8')).to.eq('Salted__');
    });
  });
});
