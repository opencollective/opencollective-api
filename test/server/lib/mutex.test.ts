import { assert } from 'chai';
import config from 'config';
import { has } from 'lodash';

import { lockUntilOrThrow, lockUntilResolved, MutexLockError } from '../../../server/lib/mutex';
import { createRedisClient } from '../../../server/lib/redis';
import { getResumableSleep, sleep, waitForCondition } from '../../utils';

describe('lockUntilResolved', () => {
  if (has(config, 'redis.serverUrl')) {
    const clearRedis = async () => {
      const redis = await createRedisClient();
      await redis.del('lock:test');
    };
    beforeEach(clearRedis);
    afterEach(clearRedis);

    it('should wait for the first lock to finish', async () => {
      const firstHold = getResumableSleep();
      let firstRunning = false;
      const pFirst = lockUntilResolved('test', async () => {
        firstRunning = true;
        await firstHold.promise;
        return 'first';
      });

      await waitForCondition(() => firstRunning, { timeout: 5000 });

      let secondRunning = false;
      const pSecond = lockUntilResolved(
        'test',
        async () => {
          secondRunning = true;
          return 'second';
        },
        { retryDelayMs: 1 },
      );

      for (let i = 0; i < 10; i++) {
        assert.isFalse(secondRunning, 'second should wait while first holds the lock');
        await sleep(5);
      }

      firstHold.resume();
      const [first, second] = await Promise.all([pFirst, pSecond]);

      assert.equal(first, 'first');
      assert.equal(second, 'second');
      assert.isTrue(secondRunning);
    });

    it('releases the lock if the callback function fails', async () => {
      const firstHold = getResumableSleep();
      let firstRunning = false;
      const pFirst = lockUntilResolved('test', async () => {
        firstRunning = true;
        await firstHold.promise;
        throw new Error('first');
      });

      await waitForCondition(() => firstRunning, { timeout: 5000 });

      let secondRunning = false;
      const pSecond = lockUntilResolved(
        'test',
        async () => {
          secondRunning = true;
          return 'second';
        },
        { retryDelayMs: 1 },
      );

      for (let i = 0; i < 10; i++) {
        assert.isFalse(secondRunning, 'second should wait while first holds the lock');
        await sleep(5);
      }

      firstHold.resume();
      const second = await pSecond;

      await assert.isRejected(pFirst, /first/);
      assert.equal(second, 'second');
      assert.isTrue(secondRunning);
    });

    it('throws if it fails to acquire a lock', async () => {
      lockUntilResolved('test3', async () => sleep(100));
      const pSecond = lockUntilResolved('test3', async () => sleep(1), { lockAcquireTimeoutMs: 50 });
      await assert.isRejected(pSecond, MutexLockError, /Timeout to acquire lock for key lock:test3/);
    });

    it('automatically releases the lock after expiring', async () => {
      lockUntilResolved('test4', async () => sleep(1000), { unlockTimeoutMs: 50 });
      await sleep(51);
      const second = await lockUntilResolved('test4', async () => 'second', {
        retryDelayMs: 1,
        lockAcquireTimeoutMs: 10,
      });
      assert.equal(second, 'second');
    });
  }
});

describe('lockUntilOrThrow', () => {
  if (has(config, 'redis.serverUrl')) {
    const clearRedis = async () => {
      const redis = await createRedisClient();
      await redis.del('lock:test');
    };
    beforeEach(clearRedis);
    afterEach(clearRedis);

    it("should throw if lock can't be acquired", async () => {
      const pFirst = lockUntilOrThrow('test', async () => {
        await sleep(25);
        return 'first';
      });
      const pSecond = lockUntilOrThrow('test', async () => {
        return 'second';
      });

      assert.equal(await pFirst, 'first');
      await assert.isRejected(pSecond, MutexLockError, /acquire lock/);
    });

    it('releases the lock if the callback function fails', async () => {
      const pFirst = lockUntilOrThrow('test', async () => {
        throw new Error('first');
      });
      await assert.isRejected(pFirst, /first/);

      const second = await lockUntilOrThrow('test', async () => {
        return 'second';
      });
      assert.equal(second, 'second');
    });

    it('should not swallow internal errors', async () => {
      const pFirst = lockUntilOrThrow('test', async () => {
        throw new Error('first');
      });

      await assert.isRejected(pFirst, /first/);
    });
  }
});
