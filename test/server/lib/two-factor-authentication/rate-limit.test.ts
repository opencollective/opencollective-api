import { expect } from 'chai';
import type { Request } from 'express';
import { createRequest, type MockRequest } from 'node-mocks-http';
import { generateSecret, generateSync } from 'otplib';
import { createSandbox } from 'sinon';

import { ApolloError } from '../../../../server/graphql/errors';
import { sessionCache } from '../../../../server/lib/cache';
import { crypto } from '../../../../server/lib/encryption';
import errors from '../../../../server/lib/errors';
import { lockUntilResolved } from '../../../../server/lib/mutex';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../../server/lib/rate-limit';
import { createRedisClient, RedisInstanceType } from '../../../../server/lib/redis';
import twoFactorAuthLib, { TwoFactorMethod } from '../../../../server/lib/two-factor-authentication';
import { TwoFactorAuthenticationHeader } from '../../../../server/lib/two-factor-authentication/lib';
import recoveryCodeProvider from '../../../../server/lib/two-factor-authentication/recovery-code';
import totpProvider from '../../../../server/lib/two-factor-authentication/totp';
import * as webauthnProvider from '../../../../server/lib/two-factor-authentication/webauthn';
import yubikeyOTPProvider from '../../../../server/lib/two-factor-authentication/yubikey-otp';
import { fakeUser } from '../../../test-helpers/fake-data';
import { getResumableSleep, waitForCondition } from '../../../utils';

describe('lib/two-factor-authentication/validateRequest rate limiting', () => {
  const sandbox = createSandbox();
  const requests: MockRequest<Request>[] = [];

  const makeRequest = async () => {
    const secret = generateSecret();
    const remoteUser = await fakeUser({ twoFactorAuthToken: crypto.encrypt(secret) });
    const req = createRequest<Request>({
      remoteUser,
      isGraphQL: true,
      body: { operationName: 'TestMutation' },
      jwtPayload: { sessionId: 'rate-limit-test' },
      headers: { [TwoFactorAuthenticationHeader]: `${TwoFactorMethod.TOTP} invalid` },
    });
    const rateLimit = new RateLimit(`user_2FA_graphql_${remoteUser.id}`, 10, ONE_HOUR_IN_SECONDS);
    requests.push(req);
    return { req, rateLimit, secret };
  };

  const failAttempts = async (req: MockRequest<Request>, count = 10) => {
    for (let i = 0; i < count; i++) {
      await expect(
        twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true }),
      ).to.eventually.be.rejected.and.deep.include({
        extensions: { code: 'INVALID_2FA_CODE' },
      });
    }
  };

  afterEach(async () => {
    sandbox.restore();
    for (const req of requests.splice(0)) {
      await sessionCache.delete(`user_2FA_graphql_${req.remoteUser.id}`);
      await sessionCache.delete(`2fa:${req.remoteUser.id}:rate-limit-test`);
    }
  });

  it('blocks token validation after 10 failures, even with a valid code', async () => {
    const { req, rateLimit, secret } = await makeRequest();
    await failAttempts(req);
    expect(await rateLimit.getCallsCount()).to.equal(10);

    req.headers[TwoFactorAuthenticationHeader] = `${TwoFactorMethod.TOTP} ${generateSync({ secret })}`;
    const validateTokenSpy = sandbox.spy(totpProvider, 'validateToken');
    await expect(twoFactorAuthLib.validateRequest(req))
      .to.be.rejectedWith(errors.TooManyRequests, 'Too many attempts. Please try again in an hour')
      .and.eventually.deep.include({ code: 429, type: 'too_many_requests' });
    expect(validateTokenSpy).not.to.have.been.called;
    expect(await sessionCache.get(`2fa:${req.remoteUser.id}:rate-limit-test`)).not.to.exist;
    expect(await rateLimit.getCallsCount()).to.equal(10);
  });

  it('allows successes within budget without consuming or resetting failures and stores a session', async () => {
    const { req, rateLimit, secret } = await makeRequest();
    await failAttempts(req, 9);

    req.headers[TwoFactorAuthenticationHeader] = `${TwoFactorMethod.TOTP} ${generateSync({ secret })}`;
    for (let i = 0; i < 11; i++) {
      await expect(twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })).to.eventually.equal(true);
    }
    expect(await rateLimit.getCallsCount()).to.equal(9);

    req.headers[TwoFactorAuthenticationHeader] = `${TwoFactorMethod.TOTP} invalid`;
    await failAttempts(req, 1);
    await expect(twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })).to.be.rejectedWith(
      errors.TooManyRequests,
    );

    // The valid session still works even after the token-validation budget is exhausted.
    delete req.headers[TwoFactorAuthenticationHeader];
    await expect(twoFactorAuthLib.validateRequest(req)).to.eventually.equal(true);
    expect(await rateLimit.getCallsCount()).to.equal(10);
  });

  it('shares failures across methods, operations, and sessions', async () => {
    const { req, rateLimit } = await makeRequest();
    const providers = [totpProvider, yubikeyOTPProvider, recoveryCodeProvider, webauthnProvider];
    const methods = [
      TwoFactorMethod.TOTP,
      TwoFactorMethod.YUBIKEY_OTP,
      TwoFactorMethod.RECOVERY_CODE,
      TwoFactorMethod.WEBAUTHN,
    ];
    const providerStubs = providers.map(provider =>
      sandbox.stub(provider, 'validateToken').rejects(new ApolloError('Invalid code', 'INVALID_2FA_CODE')),
    );

    for (let i = 0; i < 10; i++) {
      req.headers[TwoFactorAuthenticationHeader] = `${methods[i % methods.length]} invalid`;
      req.body.operationName = `Mutation${i}`;
      req.jwtPayload.sessionId = `session-${i}`;
      await failAttempts(req, 1);
    }
    expect(await rateLimit.getCallsCount()).to.equal(10);

    for (const method of methods) {
      req.headers[TwoFactorAuthenticationHeader] = `${method} invalid`;
      await expect(
        twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true, sessionKey: `new-${method}` }),
      ).to.be.rejectedWith(errors.TooManyRequests);
    }
    expect(providerStubs.reduce((count, stub) => count + stub.callCount, 0)).to.equal(10);
  });

  it('limits each user independently', async () => {
    const first = await makeRequest();
    const second = await makeRequest();
    await failAttempts(first.req);
    await expect(twoFactorAuthLib.validateRequest(first.req)).to.be.rejectedWith(errors.TooManyRequests);

    await failAttempts(second.req, 1);
    second.req.headers[TwoFactorAuthenticationHeader] =
      `${TwoFactorMethod.TOTP} ${generateSync({ secret: second.secret })}`;
    await expect(twoFactorAuthLib.validateRequest(second.req)).to.eventually.equal(true);
    expect(await first.rateLimit.getCallsCount()).to.equal(10);
    expect(await second.rateLimit.getCallsCount()).to.equal(1);
  });

  it('admits only 10 failed validations from 50 concurrent requests', async () => {
    const { req, rateLimit } = await makeRequest();
    const validateTokenStub = sandbox.stub(totpProvider, 'validateToken').callsFake(async () => {
      await new Promise(resolve => setImmediate(resolve));
      throw new ApolloError('Invalid code', 'INVALID_2FA_CODE');
    });

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })),
    );
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    expect(failures).to.have.length(50);
    expect(failures.filter(error => error.extensions?.code === 'INVALID_2FA_CODE')).to.have.length(10);
    expect(failures.filter(error => error instanceof errors.TooManyRequests)).to.have.length(40);
    expect(validateTokenStub.callCount).to.equal(10);
    expect(await rateLimit.getCallsCount()).to.equal(10);
  });

  it('does not hold up another user while a validation is in progress', async () => {
    const first = await makeRequest();
    const second = await makeRequest();
    const started = getResumableSleep();
    const hold = getResumableSleep();
    sandbox.stub(totpProvider, 'validateToken').callsFake(async user => {
      if (user.id === first.req.remoteUser.id) {
        started.resume();
        await hold.promise;
        throw new ApolloError('Invalid code', 'INVALID_2FA_CODE');
      }
    });

    const firstResult = twoFactorAuthLib.validateRequest(first.req).catch(error => error);
    try {
      await started.promise;
      await expect(twoFactorAuthLib.validateRequest(second.req)).to.eventually.equal(true);
      expect(await second.rateLimit.getCallsCount()).to.equal(0);
    } finally {
      hold.resume();
      await firstResult;
    }
    expect(await firstResult).to.have.nested.property('extensions.code', 'INVALID_2FA_CODE');
    expect(await first.rateLimit.getCallsCount()).to.equal(1);
  });

  it('rechecks the budget after acquiring the Redis lock held by another worker', async function () {
    const redis = await createRedisClient(RedisInstanceType.SESSION);
    if (!redis) {
      this.skip();
    }

    const { req, rateLimit } = await makeRequest();
    await failAttempts(req, 9);
    const validateTokenSpy = sandbox.spy(totpProvider, 'validateToken');
    const lockSetSpy = sandbox.spy(redis, 'set');
    const rateLimitKey = `user_2FA_graphql_${req.remoteUser.id}`;
    const started = getResumableSleep();
    const hold = getResumableSleep();
    const otherWorker = lockUntilResolved(rateLimitKey, async () => {
      started.resume();
      await hold.promise;
      await rateLimit.registerCall();
    });
    await started.promise;

    const result = twoFactorAuthLib.validateRequest(req).catch(error => error);
    try {
      await waitForCondition(() => lockSetSpy.withArgs(`lock:${rateLimitKey}`).callCount >= 2);
      expect(validateTokenSpy).not.to.have.been.called;
    } finally {
      hold.resume();
      await otherWorker;
      await result;
    }
    expect(await result).to.be.instanceOf(errors.TooManyRequests);
    expect(validateTokenSpy).not.to.have.been.called;
    expect(await rateLimit.getCallsCount()).to.equal(10);
  });

  it('does not count requests for a 2FA challenge as failed validations', async () => {
    const { req, rateLimit } = await makeRequest();
    delete req.headers[TwoFactorAuthenticationHeader];

    for (let i = 0; i < 11; i++) {
      await expect(twoFactorAuthLib.validateRequest(req)).to.eventually.be.rejected.and.have.nested.property(
        'extensions.code',
        '2FA_REQUIRED',
      );
    }
    expect(await rateLimit.getCallsCount()).to.equal(0);
  });
});
