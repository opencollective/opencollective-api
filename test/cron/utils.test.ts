import { assert } from 'chai';
import config from 'config';
import { has } from 'lodash';

import { runCronJob } from '../../cron/utils';
import { createRedisClient } from '../../server/lib/redis';

describe('runCronJob', () => {
  if (has(config, 'redis.serverUrl')) {
    const clearRedis = async () => {
      const redis = await createRedisClient();
      await redis.del('lock:cron:test');
    };
    beforeEach(clearRedis);
    afterEach(clearRedis);
  }

  it('should prevent two jobs from running at the same time', async () => {
    let firstCompletes = false;
    const first = runCronJob(
      'test',
      async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        firstCompletes = true;
      },
      10000,
    );

    let secondCompletes = false;
    const second = runCronJob(
      'test',
      async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        secondCompletes = true;
      },
      10000,
    );

    await Promise.all([first, second]);
    assert.equal(firstCompletes, true);
    assert.equal(secondCompletes, false);
  });
});
