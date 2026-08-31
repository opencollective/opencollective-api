import { createCipheriv, createDecipheriv, createHash, randomBytes as cryptoRandomBytes } from 'crypto';

import config from 'config';
import { randomBytes, secretbox as _secretbox } from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeUTF8 } from 'tweetnacl-util';

const { nonceLength, keyLength } = _secretbox;

const Nonce = () => randomBytes(nonceLength);

export const generateKey = () => encodeBase64(randomBytes(keyLength));

/**
 * SecretKey based authentication with nonce used for file encryption.
 */
export const secretbox = {
  encrypt(buff: Buffer, key: string): Buffer {
    const keyUint8Array = decodeBase64(key);

    const nonce = Nonce();
    const box = _secretbox(new Uint8Array(buff), nonce, keyUint8Array);

    const fullMessage = new Uint8Array(nonce.length + box.length);
    fullMessage.set(nonce);
    fullMessage.set(box, nonce.length);

    return Buffer.from(fullMessage);
  },
  decrypt(buffWithNonce: Buffer, key: string): string {
    const keyUint8Array = decodeBase64(key);
    const nonce = buffWithNonce.slice(0, nonceLength);
    const message = buffWithNonce.slice(nonceLength, buffWithNonce.length);
    const decrypted = _secretbox.open(new Uint8Array(message), new Uint8Array(nonce), keyUint8Array);

    if (!decrypted) {
      throw new Error('Could not decrypt message');
    }

    return encodeUTF8(decrypted);
  },
  /**
   * Same as decrypt, but returns a Buffer (built from the Int8Array) instead of a UTF8 string.
   */
  decryptRaw(buffWithNonce: Buffer, key: string): Buffer {
    const keyUint8Array = decodeBase64(key);
    const nonce = buffWithNonce.slice(0, nonceLength);
    const message = buffWithNonce.slice(nonceLength, buffWithNonce.length);
    const decrypted = _secretbox.open(new Uint8Array(message), new Uint8Array(nonce), keyUint8Array);
    if (!decrypted) {
      throw new Error('Could not decrypt message');
    }

    return Buffer.from(decrypted);
  },
};

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

type CipherConfig = {
  /** The NodeJS cipher algorithm to use */
  algorithm: string;
  /** The key length (in bytes) derived from the secret key */
  keyLength: number;
  /** The initialization vector length (in bytes) derived from the secret key */
  ivLength: number;
  /** An optional transformation to apply to the derived key before passing it to NodeJS */
  expandKey?: (key: Buffer) => Buffer;
};

/**
 * The ciphers we support for DB encryption, mapped to their NodeJS counterparts. The key/IV
 * lengths must match the ones used by the OpenSSL "enc" format, since that's the format the
 * data has historically been stored with.
 */
const SUPPORTED_CIPHERS: Record<string, CipherConfig> = {
  AES: { algorithm: 'aes-256-cbc', keyLength: 32, ivLength: 16 },
  // NodeJS doesn't expose single-DES anymore (it lives in OpenSSL's legacy provider), but
  // 3DES with the same key repeated three times is equivalent to it (EDE: encrypt-decrypt-encrypt).
  DES: {
    algorithm: 'des-ede3-cbc',
    keyLength: 8,
    ivLength: 8,
    expandKey: key => Buffer.concat([key, key, key]),
  },
  TripleDES: { algorithm: 'des-ede3-cbc', keyLength: 24, ivLength: 8 },
};

/** The `Salted__` magic bytes prefixing OpenSSL-encrypted payloads, followed by the 8 bytes salt */
const OPENSSL_SALT_HEADER = Buffer.from('Salted__', 'utf8');
const OPENSSL_SALT_LENGTH = 8;

const getCipherConfig = (cipher: string): CipherConfig => {
  const cipherConfig = SUPPORTED_CIPHERS[cipher];
  if (!cipherConfig) {
    throw new Error(`Unsupported cipher: ${cipher}. Supported ciphers: ${Object.keys(SUPPORTED_CIPHERS).join(', ')}`);
  }

  return cipherConfig;
};

/**
 * OpenSSL's `EVP_BytesToKey` key derivation function (MD5, 1 iteration), used to turn a
 * passphrase + salt into the key and IV of the cipher.
 *
 * /!\ This KDF is weak by modern standards, we only implement it to stay compatible with the
 * data that is already encrypted in the database.
 */
const deriveKeyAndIV = (secretKey: string, salt: Buffer, keyLength: number, ivLength: number) => {
  const secretKeyBuffer = Buffer.from(secretKey, 'utf8');
  const blocks: Buffer[] = [];
  let block = Buffer.alloc(0);
  let derivedLength = 0;
  while (derivedLength < keyLength + ivLength) {
    block = createHash('md5')
      .update(Buffer.concat([block, secretKeyBuffer, salt]))
      .digest();
    blocks.push(block);
    derivedLength += block.length;
  }

  const derived = Buffer.concat(blocks, keyLength + ivLength);
  return { key: derived.subarray(0, keyLength), iv: derived.subarray(keyLength, keyLength + ivLength) };
};

/**
 * Encrypts a message with the given secret key & cipher, using the OpenSSL "enc" format
 * (`Salted__` + salt + ciphertext, base64-encoded).
 */
export const encryptWithCipher = (message: string, secretKey: string, cipher: string): string => {
  const { algorithm, keyLength, ivLength, expandKey } = getCipherConfig(cipher);
  const salt = cryptoRandomBytes(OPENSSL_SALT_LENGTH);
  const { key, iv } = deriveKeyAndIV(secretKey, salt, keyLength, ivLength);
  const cipheriv = createCipheriv(algorithm, expandKey ? expandKey(key) : key, iv);
  const encrypted = Buffer.concat([cipheriv.update(message, 'utf8'), cipheriv.final()]);
  return Buffer.concat([OPENSSL_SALT_HEADER, salt, encrypted]).toString('base64');
};

/**
 * Decrypts a message produced by `encryptWithCipher` (or by the legacy crypto-js implementation,
 * which used the same OpenSSL "enc" format).
 */
export const decryptWithCipher = (encryptedMessage: string, secretKey: string, cipher: string): string => {
  // crypto-js used to return an empty string for empty payloads, some columns may still hold those
  if (!encryptedMessage) {
    return '';
  }

  const { algorithm, keyLength, ivLength, expandKey } = getCipherConfig(cipher);
  const payload = Buffer.from(encryptedMessage, 'base64');
  const headerLength = OPENSSL_SALT_HEADER.length + OPENSSL_SALT_LENGTH;
  if (payload.length < headerLength || !payload.subarray(0, OPENSSL_SALT_HEADER.length).equals(OPENSSL_SALT_HEADER)) {
    throw new Error('Could not decrypt message: invalid payload');
  }

  const salt = payload.subarray(OPENSSL_SALT_HEADER.length, headerLength);
  const { key, iv } = deriveKeyAndIV(secretKey, salt, keyLength, ivLength);
  const decipheriv = createDecipheriv(algorithm, expandKey ? expandKey(key) : key, iv);
  return Buffer.concat([decipheriv.update(payload.subarray(headerLength)), decipheriv.final()]).toString('utf8');
};

/**
 * SecretKey based authentication.
 * Used for DB encryption of tokens.
 */
export const crypto = {
  hash(s: string): string {
    return createHash('sha256').update(s, 'utf8').digest('hex');
  },

  encrypt(message: string): string {
    return encryptWithCipher(message, SECRET_KEY, CIPHER);
  },

  decrypt(encryptedMessage: string): string {
    return decryptWithCipher(encryptedMessage, SECRET_KEY, CIPHER);
  },
};
