import { expect } from 'chai';
import { range } from 'lodash';
import sinon from 'sinon';

import { sessionCache } from '../../../server/lib/cache';
import RateLimit from '../../../server/lib/rate-limit';
import * as SentryLib from '../../../server/lib/sentry';
import { randStr } from '../../test-helpers/fake-data';

describe('server/lib/rate-limit', () => {
  it('limits the calls with registerCall', async () => {
    const rateLimit = new RateLimit(randStr(), 2);

    expect(await rateLimit.getCallsCount()).to.equal(0);

    expect(await rateLimit.registerCall()).to.equal(true);
    expect(await rateLimit.getCallsCount()).to.equal(1);
    expect(await rateLimit.hasReachedLimit()).to.equal(false);

    expect(await rateLimit.registerCall()).to.equal(true);
    expect(await rateLimit.getCallsCount()).to.equal(2);
    expect(await rateLimit.hasReachedLimit()).to.equal(true);

    // Rejected calls are counted too
    expect(await rateLimit.registerCall()).to.equal(false);
    expect(await rateLimit.getCallsCount()).to.equal(3);

    await rateLimit.reset();
    expect(await rateLimit.getCallsCount()).to.equal(0);
  });

  it('limits concurrent calls', async () => {
    const rateLimit = new RateLimit(randStr(), 5);
    const results = await Promise.all(range(50).map(() => rateLimit.registerCall()));
    expect(results.filter(Boolean)).to.have.length(5);
  });

  it('accepts calls of several units while the count is under the limit', async () => {
    const rateLimit = new RateLimit(randStr(), 10);
    const results = await Promise.all(range(10).map(() => rateLimit.registerCall(3)));
    expect(results.filter(Boolean)).to.have.length(4); // Accepted at 0, 3, 6 and 9
  });

  it('gives back calls with unregisterCall', async () => {
    const rateLimit = new RateLimit(randStr(), 1);
    expect(await rateLimit.registerCall()).to.equal(true);
    await rateLimit.unregisterCall();
    expect(await rateLimit.getCallsCount()).to.equal(0);
    expect(await rateLimit.registerCall()).to.equal(true);
    expect(await rateLimit.registerCall()).to.equal(false);
  });

  it('never takes the counter below zero with unregisterCall', async () => {
    const rateLimit = new RateLimit(randStr(), 1);
    expect(await rateLimit.registerCall()).to.equal(true);
    await rateLimit.unregisterCall(3);
    expect(await rateLimit.getCallsCount()).to.equal(0);
    expect(await rateLimit.registerCall()).to.equal(true);
    expect(await rateLimit.registerCall()).to.equal(false);
  });

  it('does not recreate an expired window with unregisterCall', async function () {
    this.timeout(5000);
    const rateLimit = new RateLimit(randStr(), 1, 1);
    expect(await rateLimit.registerCall()).to.equal(true);
    await new Promise(resolve => setTimeout(resolve, 1100)); // The window expires between register and unregister
    await rateLimit.unregisterCall();
    expect(await sessionCache.get(rateLimit.cacheKey)).to.not.exist;

    // The next window starts clean
    expect(await rateLimit.registerCall()).to.equal(true);
    expect(await rateLimit.getCallsCount()).to.equal(1);
    expect(await rateLimit.registerCall()).to.equal(false);
  });

  it('requires an expiry in whole seconds', () => {
    expect(() => new RateLimit(randStr(), 1, 1.5)).to.throw('Invalid rate limit expiry');
    expect(() => new RateLimit(randStr(), 1, 0)).to.throw('Invalid rate limit expiry');
  });

  describe('when the store fails', () => {
    let sandbox: sinon.SinonSandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sandbox.stub(SentryLib, 'reportMessageToSentry');
      sandbox.stub(SentryLib, 'reportErrorToSentry');
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('refuses the call and reports to Sentry when the store is unavailable', async () => {
      sandbox.stub(sessionCache, 'increment').resolves(undefined);
      const rateLimit = new RateLimit(randStr(), 10);
      expect(await rateLimit.registerCall()).to.equal(false);
      expect(SentryLib.reportMessageToSentry).to.have.been.calledOnceWith(
        sinon.match.string,
        sinon.match({ severity: 'error', extra: { cacheKey: rateLimit.cacheKey } }),
      );
    });

    it('refuses the call and reports to Sentry when the store errors', async () => {
      const error = new Error('EVAL failed');
      sandbox.stub(sessionCache, 'increment').rejects(error);
      const rateLimit = new RateLimit(randStr(), 10);
      expect(await rateLimit.registerCall()).to.equal(false);
      expect(SentryLib.reportErrorToSentry).to.have.been.calledOnceWith(
        error,
        sinon.match({ severity: 'error', extra: { cacheKey: rateLimit.cacheKey } }),
      );
    });

    it('throws a rate limit error from registerCallOrThrow when the store errors', async () => {
      sandbox.stub(sessionCache, 'increment').rejects(new Error('EVAL failed'));
      const rateLimit = new RateLimit(randStr(), 10);
      await expect(rateLimit.registerCallOrThrow()).to.be.rejectedWith('Rate limit reached');
    });

    it('does not throw from unregisterCall when the store errors', async () => {
      const error = new Error('EVAL failed');
      sandbox.stub(sessionCache, 'decrement').rejects(error);
      const rateLimit = new RateLimit(randStr(), 10);
      await rateLimit.unregisterCall();
      expect(SentryLib.reportErrorToSentry).to.have.been.calledOnceWith(error);
    });
  });
});
