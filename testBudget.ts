import './server/env';

import assert from 'assert';

import config from 'config';
import { get, keys, random, sample, sampleSize } from 'lodash';
import moment from 'moment';

import { getBalances, getCollectiveBalanceAtDate, getCurrentCollectiveBalances } from './server/lib/budget';
import { Collective, Op, sequelize } from './server/models';

const testCurrentBalances = async collectiveIds => {
  console.log('Testing getCurrentCollectiveBalances');
  const expected = await getCurrentCollectiveBalances(collectiveIds);
  const actual = await getCollectiveBalanceAtDate(collectiveIds, new Date());
  const testids = keys(expected);
  testids.forEach(id => {
    assert.equal(
      actual[id].value,
      expected[id].value,
      `Balance mismatch for collective ${id}: expected ${expected[id].value}, got ${actual[id].value}`,
    );
    assert.equal(
      actual[id].currency,
      expected[id].currency,
      `Currency mismatch for collective ${id}: expected ${expected[id].currency}, got ${actual[id].currency}`,
    );
  });
  console.log('✅ getCurrentCollectiveBalances test passed');
};

const testPointInTimeBalances = async (collectiveIds, at) => {
  console.log('Testing testPointInTimeBalances');
  const expected = await getBalances(collectiveIds, { endDate: at });
  const actual = await getCollectiveBalanceAtDate(collectiveIds, at);
  const testids = keys(expected);
  testids.forEach(id => {
    try {
      assert(expected[id], `Collective ${id} not found in expected balances`);
      if (expected[id].value === 0) {
        // console.warn(`⚠️ Collective ${id} has zero balance, skipping further checks`);
        return;
      }
      assert(actual[id], `Collective ${id} not found in actual balances, balance should be ${expected[id].value}`);
      assert.equal(
        actual[id].value,
        expected[id].value,
        `Balance mismatch for collective ${id}: expected ${expected[id].value}, got ${actual[id].value}`,
      );
      assert.equal(
        actual[id].currency,
        expected[id].currency,
        `Currency mismatch for collective ${id}: expected ${expected[id].currency}, got ${actual[id].currency}`,
      );
    } catch (error) {
      console.error(`❌ Error in collective ${id}:`, error);
    }
  });
  console.log('✅ testPointInTimeBalances test passed');
};

const test = async () => {
  const host = await Collective.findByPk(11004);
  assert(host, 'Host collective not found');

  const collectives = await host.getHostedCollectives({ attributes: ['id'], raw: true });
  const collectiveIds = [host.id, ...collectives.map(result => result.id)];

  await testCurrentBalances(collectiveIds);

  const dates = Array.from({ length: 10 }).map(() =>
    moment()
      .subtract(random(0, 2, true), 'years')
      .toDate(),
  );
  for (const date of dates) {
    let collectives = await host.getHostedCollectives({
      where: { approvedAt: { [Op.lte]: date } },
      attributes: ['id'],
      raw: true,
    });
    collectives = collectives.filter(result => get(result, 'settings.budget.version') === undefined);
    console.log(`Testing balances at ${date} for ${collectives.length} collectives`);
    const collectiveIds = [host.id, ...collectives.map(result => result.id)];
    await testPointInTimeBalances(collectiveIds, date);
  }
  // await testPointInTimeBalances(collectiveIds, new Date('2024-01-04T14:42:45.852Z'));
};

test().then(() => {
  console.log('Test completed successfully');
  sequelize.close();
});
