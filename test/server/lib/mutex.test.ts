import { assert } from 'chai';
import config from 'config';
import { has } from 'lodash';

import { lockUntilResolved } from '../../../server/lib/mutex';
import { createRedisClient } from '../../../server/lib/redis';
import { sleep } from '../../utils';

describe('lockUntilResolved', () => {
  if (has(config, 'redis.serverUrl')) {
    const pRedis = createRedisClient();

    beforeEach(async () => {
      await (await pRedis).del('*');
    });
    afterEach(async () => {
      await (await pRedis).del('*');
    });

    it('should wait for the first lock to finish', async () => {
      const start = Date.now();
      let endFirst;
      const pFirst = lockUntilResolved('test', async () => {
        await sleep(50);
        return 'first';
      });
      const second = await lockUntilResolved(
        'test',
        async () => {
          endFirst = Date.now();
          await sleep(50);
          return 'second';
        },
        { retryDelayMs: 1 },
      );
      const endSecond = Date.now();

      assert.approximately(endFirst - start, 50, 5);
      assert.approximately(endSecond - start, 50 + 50, 5);
      assert.equal(await pFirst, 'first');
      assert.equal(second, 'second');
    });

    it('releases the lock if the callback function fails', async () => {
      const start = Date.now();
      let endFirst;
      const pFirst = lockUntilResolved('test', async () => {
        await sleep(50);
        throw new Error('first');
      });
      const second = await lockUntilResolved(
        'test',
        async () => {
          endFirst = Date.now();
          await sleep(50);
          return 'second';
        },
        { retryDelayMs: 5 },
      );
      const endSecond = Date.now();

      assert.approximately(endFirst - start, 50, 5);
      assert.approximately(endSecond - start, 50 + 50, 5);
      assert.isRejected(pFirst, /first/);
      assert.equal(second, 'second');
    });

    it('throws if it fails to acquire a lock', async () => {
      lockUntilResolved('test3', async () => sleep(100));
      const pSecond = lockUntilResolved('test3', async () => sleep(1), { lockAcquireTimeoutMs: 50 });
      assert.isRejected(pSecond, /Timeout to acquire lock for key lock:test3/);
    });

    it('automatically releases the lock after expiring', async () => {
      lockUntilResolved('test4', async () => sleep(1000), { unlockTimeoutMs: 100 });
      await sleep(101);
      const second = await lockUntilResolved('test4', async () => 'second', {
        retryDelayMs: 1,
        lockAcquireTimeoutMs: 10,
      });
      assert.equal(second, 'second');
    });
  }
});
