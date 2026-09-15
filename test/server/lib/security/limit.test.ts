import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import cache from '../../../../server/lib/cache';
import {
  checkOrdersLimit,
  cleanOrdersLimit,
  cleanOrdersLimitForOrder,
  getOrdersLimitKeys,
} from '../../../../server/lib/security/limit';
import * as utils from '../../../../server/lib/utils';
import { fakeCollective, fakeOrder } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('lib/security/limit', () => {
  let sandbox, collective;
  const ip = '1.1.1.1';
  const ipKey = `order_limit_on_ip_${utils.md5(ip)}`;

  before(async () => {
    await resetTestDB();
    collective = await fakeCollective();
  });

  beforeEach(async () => {
    await cache.clear();
    sandbox = createSandbox();
    sandbox.stub(config, 'env').value('production'); // The limiter is disabled in test env
    sandbox.stub(config.limits, 'ordersPerHour').value({ ...config.limits.ordersPerHour, forCollective: 2, perIp: 5 });
    sandbox.stub(utils, 'sleep').resolves();
  });

  afterEach(() => sandbox.restore());

  describe('checkOrdersLimit', () => {
    let guestOrder;
    beforeEach(() => {
      guestOrder = { collective: { id: collective.id }, guestInfo: { email: 'guest@opencollective.com' } };
    });

    it('blocks guest contributions to a collective once the limit is reached', async () => {
      await checkOrdersLimit(guestOrder, ip, null);
      await checkOrdersLimit(guestOrder, ip, null);
      await expect(checkOrdersLimit(guestOrder, ip, null)).to.be.rejectedWith('Your card was declined.');
    });

    it('is released by cleanOrdersLimit', async () => {
      await checkOrdersLimit(guestOrder, ip, null);
      await checkOrdersLimit(guestOrder, ip, null);
      await cleanOrdersLimit(guestOrder, ip, null);
      await checkOrdersLimit(guestOrder, ip, null); // Doesn't throw
    });
  });

  describe('cleanOrdersLimitForOrder', () => {
    // A logged-in user omitting `fromAccount` is checked on the IP limit only, the account is resolved later
    const limitInput = () => ({ collective: { id: collective.id } });

    it('releases exactly the keys persisted on the order', async () => {
      sandbox.stub(config.limits, 'ordersPerHour').value({ ...config.limits.ordersPerHour, perIp: 1 });
      const ordersLimitKeys = getOrdersLimitKeys(limitInput(), ip, null);
      expect(ordersLimitKeys).to.deep.eq([ipKey]);
      const order = await fakeOrder({ CollectiveId: collective.id, data: { reqIp: ip, ordersLimitKeys } });

      await checkOrdersLimit(limitInput(), ip, null);
      await expect(checkOrdersLimit(limitInput(), ip, null)).to.be.rejected;
      await cleanOrdersLimitForOrder(order);
      await checkOrdersLimit(limitInput(), ip, null); // Doesn't throw
    });

    it('does nothing when no keys were persisted', async () => {
      const order = await fakeOrder({ CollectiveId: collective.id, data: { reqIp: ip } });
      await checkOrdersLimit(limitInput(), ip, null);
      await cleanOrdersLimitForOrder(order);
      expect(await cache.get(ipKey)).to.eq(1);
    });

    it('does nothing for collectives listed in skipCleanOrdersLimitSlugs', async () => {
      sandbox.stub(config.limits, 'skipCleanOrdersLimitSlugs').value(collective.slug);
      const ordersLimitKeys = getOrdersLimitKeys(limitInput(), ip, null);
      const order = await fakeOrder({ CollectiveId: collective.id, data: { reqIp: ip, ordersLimitKeys } });
      await checkOrdersLimit(limitInput(), ip, null);
      await cleanOrdersLimitForOrder(order);
      expect(await cache.get(ipKey)).to.eq(1);
    });
  });
});
