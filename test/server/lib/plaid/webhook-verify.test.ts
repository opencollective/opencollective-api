import crypto from 'crypto';

import { expect } from 'chai';
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import nock from 'nock';
import { Plaid } from 'plaid';
import sinon from 'sinon';

import { sessionCache } from '../../../../server/lib/cache';
import * as PlaidClientLib from '../../../../server/lib/plaid/client';
import { verifyPlaidWebhookRequest } from '../../../../server/lib/plaid/webhook-verify';
import { sha256 } from '../../../../server/lib/utils';

/* eslint-disable camelcase */
const webhookBody = { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-1' };

// Plaid signs the SHA-256 of the body formatted with a 2-space indentation
const bodyHash = (body: object) => sha256(JSON.stringify(body, null, 2));

const makeKey = (kid: string, { expired = false } = {}) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publicJwk: Plaid.JwkPublicKey = {
    alg: 'ES256',
    created_at: 1700000000,
    crv: jwk.crv,
    expired_at: expired ? 1700000001 : null,
    kid,
    kty: jwk.kty,
    use: 'sig',
    x: jwk.x,
    y: jwk.y,
  };
  return { privateKey, publicJwk };
};

const sign = (privateKey: crypto.KeyObject, kid: string, claims: Record<string, unknown>) =>
  jwt.sign(claims, privateKey, { algorithm: 'ES256', keyid: kid });

const makeRequest = (token: string | undefined, body: object = webhookBody) =>
  ({ headers: token ? { 'plaid-verification': token } : {}, rawBody: JSON.stringify(body) }) as unknown as Request;

describe('server/lib/plaid/webhook-verify', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    const client = PlaidClientLib.createPlaidClient({
      clientId: 'test-client-id',
      secret: 'test-secret',
      env: 'sandbox',
    });
    sandbox.stub(PlaidClientLib, 'getPlaidClient').returns(client);
    await sessionCache.delete('plaid:webhook-keys');
  });

  afterEach(() => {
    sandbox.restore();
    nock.cleanAll();
  });

  const serveKey = (publicJwk: Plaid.JwkPublicKey) =>
    nock('https://sandbox.plaid.com')
      .post('/webhook_verification_key/get', { key_id: publicJwk.kid })
      .reply(200, { key: publicJwk, request_id: 'request-id' });

  it('accepts a webhook signed by a Plaid key, and caches the key', async () => {
    const { privateKey, publicJwk } = makeKey('key-1');
    const scope = serveKey(publicJwk);
    const token = sign(privateKey, 'key-1', { request_body_sha256: bodyHash(webhookBody) });

    expect(await verifyPlaidWebhookRequest(makeRequest(token))).to.be.true;
    expect(scope.isDone()).to.be.true;

    // Served from the cache: Plaid is not called again (nock has no interceptor left)
    expect(await verifyPlaidWebhookRequest(makeRequest(token))).to.be.true;
  });

  it('rejects a request without a signature', async () => {
    expect(await verifyPlaidWebhookRequest(makeRequest(undefined))).to.be.false;
  });

  it('rejects a body that does not match the signed hash', async () => {
    const { privateKey, publicJwk } = makeKey('key-1');
    serveKey(publicJwk);
    const token = sign(privateKey, 'key-1', { request_body_sha256: bodyHash(webhookBody) });
    const tamperedBody = { ...webhookBody, item_id: 'item-2' };

    expect(await verifyPlaidWebhookRequest(makeRequest(token, tamperedBody))).to.be.false;
  });

  it('rejects a signed hash of the wrong length', async () => {
    const { privateKey, publicJwk } = makeKey('key-1');
    serveKey(publicJwk);
    const token = sign(privateKey, 'key-1', { request_body_sha256: 'abc' });

    expect(await verifyPlaidWebhookRequest(makeRequest(token))).to.be.false;
  });

  it('rejects a token signed by another key', async () => {
    const { publicJwk } = makeKey('key-1');
    const { privateKey: otherPrivateKey } = makeKey('key-1');
    serveKey(publicJwk);
    const token = sign(otherPrivateKey, 'key-1', { request_body_sha256: bodyHash(webhookBody) });

    expect(await verifyPlaidWebhookRequest(makeRequest(token))).to.be.false;
  });

  it('rejects a token issued more than 5 minutes ago', async () => {
    const { privateKey, publicJwk } = makeKey('key-1');
    serveKey(publicJwk);
    const iat = Math.floor(Date.now() / 1000) - 6 * 60;
    const token = sign(privateKey, 'key-1', { request_body_sha256: bodyHash(webhookBody), iat });

    expect(await verifyPlaidWebhookRequest(makeRequest(token))).to.be.false;
  });

  it('rejects a key that Plaid reports as expired', async () => {
    const { privateKey, publicJwk } = makeKey('key-1', { expired: true });
    serveKey(publicJwk);
    const token = sign(privateKey, 'key-1', { request_body_sha256: bodyHash(webhookBody) });

    expect(await verifyPlaidWebhookRequest(makeRequest(token))).to.be.false;
  });

  it('rejects a key ID that Plaid does not know', async () => {
    const { privateKey } = makeKey('unknown-key');
    nock('https://sandbox.plaid.com').post('/webhook_verification_key/get', { key_id: 'unknown-key' }).reply(400, {
      error_type: 'INVALID_INPUT',
      error_code: 'INVALID_WEBHOOK_VERIFICATION_KEY_ID',
      error_message: 'invalid key_id provided',
      display_message: null,
      request_id: 'request-id',
    });
    const token = sign(privateKey, 'unknown-key', { request_body_sha256: bodyHash(webhookBody) });

    expect(await verifyPlaidWebhookRequest(makeRequest(token))).to.be.false;
  });
});
/* eslint-enable camelcase */
