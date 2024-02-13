import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import models from '../../../server/models';
import { randEmail } from '../../stores';
import { fakeOrder } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('server/models/Order', () => {
  const sandbox = sinon.createSandbox();
  let user, collective, tier, order;

  afterEach(() => {
    sandbox.restore();
  });

  before(() => utils.resetTestDB());
  before('create a user', () =>
    models.User.createUserWithCollective({
      email: randEmail(),
      name: 'Xavier',
    }).then(u => (user = u)),
  );
  before('create a collective', () => models.Collective.create({ name: 'Webpack' }).then(c => (collective = c)));
  before('create a tier', () =>
    models.Tier.create({ name: 'backer', amount: 0, CollectiveId: collective.id }).then(t => (tier = t)),
  );
  before('create an order', () =>
    models.Order.create({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      TierId: tier.id,
      totalAmount: 1000,
      currency: 'USD',
    }).then(o => (order = o)),
  );

  it('populates the foreign keys', done => {
    order.populate().then(order => {
      expect(order.createdByUser.id).to.equal(user.id);
      expect(order.fromCollective.id).to.equal(user.CollectiveId);
      expect(order.collective.id).to.equal(collective.id);
      expect(order.tier.id).to.equal(tier.id);
      expect(order.paymentMethod).to.not.exist;
      done();
    });
  });

  describe('lock', () => {
    it('sets the date of the lock', async () => {
      // Lock the order
      const lockSuccess = await order.lock(async () => {
        await order.reload();
        expect(order.data.lockedAt).to.exist;
        expect(moment(order.lockedAt).isSameOrAfter(moment().subtract(30, 'second'))).to.be.true;
        expect(order.isLocked()).to.be.true;
      });

      expect(lockSuccess).to.be.true;

      // Unlocks the order
      await order.reload();
      expect(order.data.lockedAt).to.not.exist;
      expect(order.isLocked()).to.be.false;
    });

    it('throws if the order is already locked', async () => {
      await expect(order.lock(() => order.lock())).to.be.rejectedWith(
        'This order is already been processed, please try again later',
      );
    });

    it('retries the lock if it fails', async () => {
      const lockSpy = sandbox.spy(order, 'lock');
      const [firstLockSuccess, secondLockSuccess] = await Promise.all([
        order.lock(() => new Promise(resolve => setTimeout(resolve, 100))),
        order.lock(() => {}, { retries: 1000, retryDelay: 1 }),
      ]);

      expect(firstLockSuccess).to.be.true;
      expect(secondLockSuccess).to.be.true;
      expect(lockSpy.callCount).to.be.above(2); // Function is a recursive, we make sure it called itself at least once
      expect(lockSpy.firstCall.args[1]).to.not.exist; // We haven't passed any options to the first call
      expect(lockSpy.secondCall.args[1].retries).to.equal(1000);
      expect(lockSpy.secondCall.args[1].retryDelay).to.equal(1);
      expect(lockSpy.thirdCall.args[1].retries).to.equal(999);
      expect(lockSpy.thirdCall.args[1].retryDelay).to.equal(1);
    });

    it('can clear all expired locks using Order.clearExpiredLocks', async () => {
      const expiredOrderLockDate = moment().subtract(1, 'hour').toDate();
      const orderWithExpiredLock = await fakeOrder({ data: { lockedAt: expiredOrderLockDate } });
      const orderWithValidLock = await fakeOrder({ data: { lockedAt: new Date() } });
      const orderWithNoLock = await fakeOrder();

      const [, nbUnlocked] = await models.Order.clearExpiredLocks();
      expect(nbUnlocked).to.equal(1);

      await orderWithNoLock.reload();
      expect(orderWithNoLock.isLocked()).to.be.false;

      await orderWithValidLock.reload();
      expect(orderWithValidLock.isLocked()).to.be.true;

      await orderWithExpiredLock.reload();
      expect(orderWithExpiredLock.isLocked()).to.be.false;
      expect(orderWithExpiredLock.data.deadlocks).to.deep.equal([expiredOrderLockDate.toISOString()]);

      // Calling it a second time should happen the second deadlock
      const secondLockDate = moment().subtract(45, 'minutes').toDate();
      await orderWithExpiredLock.update({ data: { ...orderWithExpiredLock.data, lockedAt: secondLockDate } });

      const [, nbUnlocked2] = await models.Order.clearExpiredLocks();
      expect(nbUnlocked2).to.equal(1);
      await orderWithExpiredLock.reload();
      expect(orderWithExpiredLock.isLocked()).to.be.false;
      expect(orderWithExpiredLock.data.deadlocks).to.deep.equal([
        expiredOrderLockDate.toISOString(),
        secondLockDate.toISOString(),
      ]);
    });
  });
});
