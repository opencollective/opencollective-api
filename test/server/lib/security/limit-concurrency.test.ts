import { expect } from 'chai';
import config from 'config';
import sinon from 'sinon';

import cache from '../../../../server/lib/cache';
import makeMemoryProvider from '../../../../server/lib/cache/memory';
import logger from '../../../../server/lib/logger';
import { checkManualOrdersLimit, checkOrdersLimit } from '../../../../server/lib/security/limit';
import * as utils from '../../../../server/lib/utils';

const createReadBarrier = (expectedReads: number) => {
  let reads = 0;
  let release: (() => void) | undefined;
  const allReadsReachedBarrier = new Promise<void>(resolve => {
    release = resolve;
  });

  return {
    wait: async () => {
      reads++;
      if (reads === expectedReads) {
        release?.();
      }
      await allReadsReachedBarrier;
    },
  };
};

describe('server/lib/security/limit concurrency', () => {
  let sandbox: sinon.SinonSandbox;
  let isolatedCache: ReturnType<typeof makeMemoryProvider>;
  let incrementCache: sinon.SinonStub;
  let readBarrier: ReturnType<typeof createReadBarrier>;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    isolatedCache = makeMemoryProvider({ max: 100, ttlResolution: 0 });
    sandbox.stub(config, 'env').value('production');
    sandbox.stub(cache, 'get').callsFake(async key => {
      const value = await isolatedCache.get(key);
      await readBarrier?.wait();
      return value;
    });
    sandbox.stub(cache, 'set').callsFake((key, value, ttl) => isolatedCache.set(key, value, ttl));
    incrementCache = sandbox.stub(cache, 'incrementWithSlidingExpiration').callsFake((key, amount, ttl) => {
      return isolatedCache.incrementWithSlidingExpiration(key, amount, ttl);
    });
    sandbox.stub(utils, 'sleep').resolves();
  });

  afterEach(() => sandbox.restore());

  it('enforces the order limit across concurrent requests', async () => {
    sandbox.stub(config.limits, 'ordersPerHour').value({ ...config.limits.ordersPerHour, perIp: 1 });
    readBarrier = createReadBarrier(10);
    const order = { collective: { id: 123 } };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkOrdersLimit(order, '192.0.2.10', undefined).then(
          () => true,
          () => false,
        ),
      ),
    );

    expect(results.filter(Boolean)).to.have.length(1);
    expect(await isolatedCache.get(`order_limit_on_ip_${utils.md5('192.0.2.10')}`)).to.equal(10);
  });

  it('enforces the manual order limit across concurrent requests', async () => {
    sandbox.stub(config.limits, 'manualOrdersPerHour').value({ perUser: 1, perIp: 1 });
    readBarrier = createReadBarrier(10);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkManualOrdersLimit({ id: 456 }, '').then(
          () => true,
          () => false,
        ),
      ),
    );

    expect(results.filter(Boolean)).to.have.length(1);
    expect(await isolatedCache.get('manual_order_limit_on_user_456')).to.equal(10);
  });

  it('allows requests when the cache operation reports an unavailable store', async () => {
    incrementCache.resolves(undefined);
    sandbox.stub(config.limits, 'ordersPerHour').value({ ...config.limits.ordersPerHour, perIp: 1 });
    sandbox.stub(config.limits, 'manualOrdersPerHour').value({ perUser: 1, perIp: 1 });

    await checkOrdersLimit({ collective: { id: 123 } }, '192.0.2.11', undefined);
    await checkManualOrdersLimit({ id: 456 }, '');
  });

  it('logs cache errors and allows requests when the store rejects the operation', async () => {
    incrementCache.rejects(new Error('cache unavailable'));
    const logWarning = sandbox.stub(logger, 'warn');
    sandbox.stub(config.limits, 'ordersPerHour').value({ ...config.limits.ordersPerHour, perIp: 1 });
    sandbox.stub(config.limits, 'manualOrdersPerHour').value({ perUser: 1, perIp: 1 });

    await checkOrdersLimit({ collective: { id: 123 } }, '192.0.2.12', undefined);
    await checkManualOrdersLimit({ id: 456 }, '');

    expect(logWarning.callCount).to.equal(2);
    expect(logWarning.calledWith('Error while incrementing cache: cache unavailable')).to.equal(true);
  });

  it('still blocks requests when a zero limit is configured and the cache is unavailable', async () => {
    incrementCache.resolves(undefined);
    sandbox.stub(config.limits, 'ordersPerHour').value({ ...config.limits.ordersPerHour, perIp: 0 });
    sandbox.stub(config.limits, 'manualOrdersPerHour').value({ perUser: 0, perIp: 0 });

    const orderError = await checkOrdersLimit({ collective: { id: 123 } }, '192.0.2.13', undefined).then(
      () => undefined,
      error => error,
    );
    expect(orderError?.message).to.equal('Your card was declined.');

    const manualOrderError = await checkManualOrdersLimit({ id: 456 }, '').then(
      () => undefined,
      error => error,
    );
    expect(manualOrderError?.message).to.equal('Too many contributions in the last hour, please try again later.');
  });
});
