import config from 'config';
import cryptojs from 'crypto-js';
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
    const box = _secretbox(buff, nonce, keyUint8Array);

    const fullMessage = new Uint8Array(nonce.length + box.length);
    fullMessage.set(nonce);
    fullMessage.set(box, nonce.length);

    return Buffer.from(fullMessage);
  },
  decrypt(buffWithNonce: Buffer, key: string): string {
    const keyUint8Array = decodeBase64(key);
    const nonce = buffWithNonce.slice(0, nonceLength);
    const message = buffWithNonce.slice(nonceLength, buffWithNonce.length);
    const decrypted = _secretbox.open(message, nonce, keyUint8Array);

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
    const decrypted = _secretbox.open(message, nonce, keyUint8Array);
    if (!decrypted) {
      throw new Error('Could not decrypt message');
    }

    return Buffer.from(decrypted);
  },
};

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

/**
 * SecretKey based authentication.
 * Used for DB encryption of tokens.
 */
export const crypto = {
  hash(s: string): string {
    return cryptojs.SHA256(s).toString();
  },

  encrypt(message: string): string {
    return cryptojs[CIPHER].encrypt(message, SECRET_KEY).toString();
  },

  decrypt(encryptedMessage: string): string {
    return cryptojs[CIPHER].decrypt(encryptedMessage, SECRET_KEY).toString(cryptojs.enc.Utf8);
  },
};
