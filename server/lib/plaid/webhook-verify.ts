import * as crypto from 'crypto';

import { Request } from 'express';
import * as jwt from 'jsonwebtoken';
import { uniq } from 'lodash';
import { JWKPublicKey } from 'plaid';

import { sessionCache } from '../cache';
import { reportErrorToSentry } from '../sentry';
import { sha256 } from '../utils';

import { getPlaidClient } from './client';
import { PlaidWebhookDecodedJWTToken } from './types';

const updateKeysCache = async (keys: readonly string[]): Promise<Record<string, JWKPublicKey>> => {
  const PlaidClient = getPlaidClient();
  const newCache: Record<string, JWKPublicKey> = {};

  // Fetch valid keys
  const results = await Promise.allSettled(
    uniq(keys).map(async (keyID: string): Promise<[string, JWKPublicKey] | undefined> => {
      // eslint-disable-next-line camelcase
      const response = await PlaidClient.webhookVerificationKeyGet({ key_id: keyID });
      const key = response.data.key;
      if (!key.expired_at) {
        return [keyID, key];
      }
    }),
  );

  // Add all valid keys in cache
  results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value)
    .filter(Boolean)
    .forEach(([keyID, key]) => {
      newCache[keyID] = key;
    });

  // Report errors to Sentry, but do not throw if the cache update fails
  try {
    await sessionCache.set('plaid:webhook-keys', newCache);
  } catch (e) {
    reportErrorToSentry(e);
  }

  return newCache;
};

function jwkToPem(jwk) {
  const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return keyObject.export({ type: 'spki', format: 'pem' });
}

/**
 * Verifies the webhook event.
 * Adapted from https://plaid.com/docs/api/webhooks/webhook-verification/#example-implementation.
 */
export const verifyPlaidWebhookRequest = async (req: Request) => {
  // Get token from header
  const signedJwt = req.headers['plaid-verification'] as string;
  if (!signedJwt) {
    return false;
  }

  // Decode provided token & check its format
  let decodedToken, currentKeyID;
  try {
    decodedToken = jwt.decode(signedJwt, { complete: true }) as PlaidWebhookDecodedJWTToken;
    currentKeyID = decodedToken.header.kid;
    if (!currentKeyID) {
      return false;
    }
  } catch {
    return false;
  }

  // If key not in cache, update the key cache. Do not throw if the cache is unavailable.
  let keysFromCache: Record<string, JWKPublicKey> = {};
  try {
    keysFromCache = (await sessionCache.get('plaid:webhook-keys')) || {};
  } catch (e) {
    reportErrorToSentry(e);
  }

  if (!keysFromCache[currentKeyID]) {
    keysFromCache = await updateKeysCache([...Object.keys(keysFromCache), currentKeyID]);
  }

  // If the key ID is not in the cache, the key ID may be invalid.
  const key = keysFromCache[currentKeyID];
  if (!key) {
    return false;
  } else if (key.expired_at) {
    return false;
  }

  // Validate the signature and extract the claims
  let claims: any;
  try {
    const pem = jwkToPem(key);
    claims = jwt.verify(signedJwt, pem, { algorithms: [key.alg as jwt.Algorithm] });
  } catch (error) {
    return false;
  }

  // Ensure that the token is not expired (based on https://plaid.com/docs/api/webhooks/webhook-verification/, the token is valid for 5 minutes)
  if (claims.iat < Math.floor(Date.now() / 1000) - 5 * 60) {
    return false;
  }

  // Ensure that the hash of the body matches the claim
  const expectedBuffer = new Uint8Array(Buffer.from(claims.request_body_sha256));
  const formattedJsonHash = sha256(JSON.stringify(JSON.parse(req.rawBody), null, 2)); // Format body to match Plaid's expectations
  return crypto.timingSafeEqual(new Uint8Array(Buffer.from(formattedJsonHash)), expectedBuffer);
};
