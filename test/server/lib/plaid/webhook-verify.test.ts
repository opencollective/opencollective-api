import * as crypto from 'crypto';

import { expect } from 'chai';
import sinon from 'sinon';

import { sessionCache } from '../../../../server/lib/cache';
import { verifyPlaidWebhookRequest } from '../../../../server/lib/plaid/webhook-verify';
import { sha256 } from '../../../../server/lib/utils';
import { makeRequest } from '../../../utils';

describe('server/lib/plaid/webhook-verify', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  const buildKeyPair = () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const key: Record<string, unknown> = { ...publicJwk, alg: 'RS256', ['expired_at']: null };
    return { privateKey, key };
  };

  type WebhookRequest = ReturnType<typeof makeRequest> & { rawBody: string };

  const buildRequest = (rawBody: string, signedJwt?: string): WebhookRequest => {
    const headers = signedJwt ? { 'plaid-verification': signedJwt } : {};
    const req = makeRequest(undefined, undefined, undefined, headers);
    return { ...req, rawBody };
  };

  const base64UrlEncode = (value: string | Buffer) =>
    Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const signJwt = ({
    payload,
    kid,
    privateKey,
  }: {
    payload: Record<string, unknown>;
    kid: string;
    privateKey: crypto.KeyObject;
  }) => {
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
    return `${signingInput}.${base64UrlEncode(signature)}`;
  };

  const verifyRequest = (req: WebhookRequest) => verifyPlaidWebhookRequest(req as any);

  it('returns false when the plaid-verification header is missing', async () => {
    const req = buildRequest(JSON.stringify({ foo: 'bar' }));
    const result = await verifyRequest(req);
    expect(result).to.be.false;
  });

  it('returns false when the plaid-verification header is not a valid JWT', async () => {
    const cacheStub = sandbox.stub(sessionCache, 'get').resolves({});
    const req = buildRequest(JSON.stringify({ foo: 'bar' }), 'not-a-jwt');
    const result = await verifyRequest(req);
    expect(result).to.be.false;
    expect(cacheStub).to.not.have.been.called;
  });

  it('returns false when the token is older than five minutes', async () => {
    const { privateKey, key } = buildKeyPair();
    const kid = 'plaid-key-1';
    const rawBody = JSON.stringify({ foo: 'bar' });
    const requestBodyHash = sha256(JSON.stringify(JSON.parse(rawBody), null, 2));
    const signedJwt = signJwt({
      payload: {
        iat: Math.floor(Date.now() / 1000) - 6 * 60,
        ['request_body_sha256']: requestBodyHash,
      },
      kid,
      privateKey,
    });

    sandbox.stub(sessionCache, 'get').resolves({ [kid]: key });

    const req = buildRequest(rawBody, signedJwt);
    const result = await verifyRequest(req);
    expect(result).to.be.false;
  });

  it('returns true when the signature, timestamp, and body hash are valid', async () => {
    const { privateKey, key } = buildKeyPair();
    const kid = 'plaid-key-2';
    const rawBody = JSON.stringify({ foo: 'bar', amount: 123 });
    const requestBodyHash = sha256(JSON.stringify(JSON.parse(rawBody), null, 2));
    const signedJwt = signJwt({
      payload: {
        iat: Math.floor(Date.now() / 1000),
        ['request_body_sha256']: requestBodyHash,
      },
      kid,
      privateKey,
    });

    sandbox.stub(sessionCache, 'get').resolves({ [kid]: key });

    const req = buildRequest(rawBody, signedJwt);
    const result = await verifyRequest(req);
    expect(result).to.be.true;
  });
});
