import { assert } from 'chai';
import config from 'config';
import { has, range } from 'lodash';

import { getProvider, PROVIDER_TYPES } from '../../../../server/lib/cache';
import makeMemoryProvider from '../../../../server/lib/cache/memory';
import { createRedisClient } from '../../../../server/lib/redis';

const providersToTest = [PROVIDER_TYPES.MEMORY];
if (has(config, 'redis.serverUrl')) {
  providersToTest.push(PROVIDER_TYPES.REDIS);
}

describe('server/lib/cache/cacheProvider', () => {
  providersToTest.forEach(provider => {
    describe(`${provider} provider get / set`, () => {
      let cache;
      before(async () => {
        cache = await getProvider(provider);
      });

      it('zero (integer) is returned as zero (integer)', async () => {
        cache.set('zero_as_integer', 0);
        const value = await cache.get('zero_as_integer');
        assert.strictEqual(value, 0);
      });

      it('zero (string) is returned as zero (string)', async () => {
        cache.set('zero_as_string', '0');
        const value = await cache.get('zero_as_string');
        assert.strictEqual(value, '0');
      });

      it('one (integer) is returned as one (integer)', async () => {
        cache.set('one_as_integer', 1);
        const value = await cache.get('one_as_integer');
        assert.strictEqual(value, 1);
      });

      it('one (string) is returned as one (string)', async () => {
        cache.set('one_as_string', '1');
        const value = await cache.get('one_as_string');
        assert.strictEqual(value, '1');
      });

      it('three (integer) is returned as three (integer)', async () => {
        cache.set('three_as_integer', 3);
        const value = await cache.get('three_as_integer');
        assert.strictEqual(value, 3);
      });

      it('three (string) is returned as three (string)', async () => {
        cache.set('three_as_string', '3');
        const value = await cache.get('three_as_string');
        assert.strictEqual(value, '3');
      });

      it('three (object) is returned as three (object)', async () => {
        cache.set('three_as_object', { three: 3 });
        const value = await cache.get('three_as_object');
        assert.deepEqual(value, { three: 3 });
      });

      it('empty object is returned as empty object', async () => {
        cache.set('empty_object', {});
        const value = await cache.get('empty_object');
        assert.deepEqual(value, {});
      });

      it('undefined is returned as undefined', async () => {
        cache.set('undefined_as_undefined', undefined);
        const value = await cache.get('undefined_as_undefined');
        assert.strictEqual(value, undefined);
      });

      it('null is returned as null', async () => {
        cache.set('null_as_null', null);
        const value = await cache.get('null_as_null');
        assert.strictEqual(value, null);
      });

      it('false is returned as false', async () => {
        cache.set('false_as_false', false);
        const value = await cache.get('false_as_false');
        assert.strictEqual(value, false);
      });

      it('true is returned as true', async () => {
        cache.set('true_as_true', true);
        const value = await cache.get('true_as_true');
        assert.strictEqual(value, true);
      });

      it('clear is available', async () => {
        await cache.clear();
      });

      it('list keys matching a pattern', async () => {
        cache.set('key1', 1);
        cache.set('key2', 2);
        cache.set('key3', 3);
        cache.set('nonkey1', 1);
        let keys = await cache.keys('key*');
        assert.includeMembers(keys, ['key1', 'key2', 'key3']);
        assert.notInclude(keys, 'nonkey1');

        keys = await cache.keys('*key*');
        assert.includeMembers(keys, ['key1', 'key2', 'key3', 'nonkey1']);
      });

      it('deletes a single key', async () => {
        cache.set('key1', 1);
        cache.set('key2', 2);
        cache.set('key3', 3);
        await cache.delete('key1');

        const keys = await cache.keys('key*');
        assert.includeMembers(keys, ['key2', 'key3']);
        assert.notInclude(keys, 'key1');
      });

      it('deletes multiple keys', async () => {
        cache.set('key1', 1);
        cache.set('key2', 2);
        cache.set('key3', 3);
        await cache.delete(['key1', 'key2']);

        const keys = await cache.keys('key*');
        assert.deepEqual(keys, ['key3']);
      });
    });

    describe(`${provider} provider increment`, () => {
      let cache;
      before(async () => {
        cache = await getProvider(provider);
      });

      beforeEach(async () => {
        await cache.delete(['increment_total', 'increment_concurrent', 'increment_existing', 'increment_ttl']);
      });

      it('returns the running total', async () => {
        assert.strictEqual(await cache.increment('increment_total', 1, 60), 1);
        assert.strictEqual(await cache.increment('increment_total', 3, 60), 4);
        assert.strictEqual(await cache.increment('increment_total', -1, 60), 3);
        assert.strictEqual(await cache.get('increment_total'), 3);
      });

      it('does not lose concurrent increments', async () => {
        const results = await Promise.all(range(50).map(() => cache.increment('increment_concurrent', 1, 60)));
        assert.sameMembers(results, range(1, 51));
      });

      it('increments a value stored with set', async () => {
        await cache.set('increment_existing', 3, 60);
        assert.strictEqual(await cache.increment('increment_existing', 1, 60), 4);
        assert.strictEqual(await cache.get('increment_existing'), 4);
      });

      if (provider === PROVIDER_TYPES.MEMORY) {
        it('only sets the expiry when the key is created', async () => {
          let now = 1000; // lru-cache ignores the TTL of entries created at time 0
          const memoryCache = makeMemoryProvider({ max: 10, ttlResolution: 0, perf: { now: () => now } });
          assert.strictEqual(await memoryCache.increment('increment_ttl', 1, 60), 1);
          now += 59 * 1000;
          assert.strictEqual(await memoryCache.increment('increment_ttl', 1, 60), 2);
          now += 2 * 1000;
          assert.strictEqual(await memoryCache.increment('increment_ttl', 1, 60), 1);
        });
      } else {
        it('only sets the expiry when the key has none', async () => {
          const redis = await createRedisClient();
          await cache.increment('increment_ttl', 1, 60);
          assert.isAbove(await redis.ttl('increment_ttl'), 55);

          await redis.expire('increment_ttl', 5);
          await cache.increment('increment_ttl', 1, 60);
          assert.isAtMost(await redis.ttl('increment_ttl'), 5);

          await redis.persist('increment_ttl');
          await cache.increment('increment_ttl', 1, 60);
          assert.isAbove(await redis.ttl('increment_ttl'), 55);
        });
      }
    });
  });
});
