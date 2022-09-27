import { expect } from 'chai';
import config from 'config';

import { checkEmail, checkIP, checkUser, getEmailStats, getIpStats, getUserStats } from '../../../server/lib/fraud';
import { fakeOrder, fakePaymentMethod, fakeUser, multiple } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('lib/fraud', () => {
  let user;
  before(async () => {
    await resetTestDB();
    user = await fakeUser({ email: 'crook@tempmail.com' });
    const pm = await fakePaymentMethod({
      type: 'creditcard',
      service: 'stripe',
      CollectiveId: user.collective.id,
      name: '4242',
      data: { expYear: 2022 },
    });
    const defaultOrderProps = {
      CreatedByUserId: user.id,
      PaymentMethodId: pm.id,
      data: { reqIp: '127.0.0.1' },
    };
    await multiple(fakeOrder, 4, { ...defaultOrderProps, status: 'ERROR' });
    await multiple(fakeOrder, 1, { ...defaultOrderProps, status: 'PAID' });
    // Add Noise
    await multiple(fakeOrder, 5, { status: 'ERROR', PaymentMethodId: pm.id });
    await multiple(fakeOrder, 5, { status: 'PAID', PaymentMethodId: pm.id });
  });

  describe('getUserStats', () => {
    it('should return stats for existing user', async () => {
      const stats = await getUserStats(user);
      expect(stats).to.have.property('errorRate', 0.8);
      expect(stats).to.have.property('numberOfOrders', 5);
      expect(stats).to.have.property('paymentMethodRate', 0.2);
    });

    it('should return empty stats if user has no orders', async () => {
      const otherUser = await fakeUser();
      const stats = await getUserStats(otherUser);
      expect(stats).to.have.property('errorRate', 0);
      expect(stats).to.have.property('numberOfOrders', 0);
      expect(stats).to.have.property('paymentMethodRate', 0);
    });
  });

  describe('getEmailStats', () => {
    it('should return stats for any given email address', async () => {
      const stats = await getEmailStats('crook@tempmail.com');
      expect(stats).to.have.property('errorRate', 0.8);
      expect(stats).to.have.property('numberOfOrders', 5);
      expect(stats).to.have.property('paymentMethodRate', 0.2);
    });

    it('should return stats for any given domain expression', async () => {
      const stats = await getEmailStats('%tempmail.com');
      expect(stats).to.have.property('errorRate', 0.8);
      expect(stats).to.have.property('numberOfOrders', 5);
      expect(stats).to.have.property('paymentMethodRate', 0.2);
    });
  });

  describe('getIpStats', () => {
    it('should return stats for any given IP address', async () => {
      const stats = await getIpStats('127.0.0.1');
      expect(stats).to.have.property('errorRate', 0.8);
      expect(stats).to.have.property('numberOfOrders', 5);
      expect(stats).to.have.property('paymentMethodRate', 0.2);
    });

    it('should return stats for any given IP expression', async () => {
      const stats = await getIpStats('127.0.%');
      expect(stats).to.have.property('errorRate', 0.8);
      expect(stats).to.have.property('numberOfOrders', 5);
      expect(stats).to.have.property('paymentMethodRate', 0.2);
    });
  });

  describe('checkUser', () => {
    const defaultU1M = config.fraud.order.U1M;

    after(() => {
      config.fraud.order.U1M = defaultU1M;
    });

    it('should pass if user stats are below treshold', async () => {
      await expect(checkUser(user)).to.be.fulfilled;
    });

    it('should throw if user stats hit the treshold', async () => {
      config.fraud.order.U1M = '[[5, 0.8, 0.2]]';
      await expect(checkUser(user)).to.be.rejectedWith('above treshold');
    });
  });

  describe('checkIP', () => {
    const defaultI5D = config.fraud.order.I5D;

    after(() => {
      config.fraud.order.I5D = defaultI5D;
    });

    it('should pass if ip stats are below treshold', async () => {
      await expect(checkIP('127.0.0.1')).to.be.fulfilled;
    });

    it('should throw if ip stats hit the treshold', async () => {
      config.fraud.order.I5D = '[[5, 0.8, 0.2]]';
      await expect(checkIP('127.0.0.1')).to.be.rejectedWith('above treshold');
    });
  });

  describe('checkEmail', () => {
    const defaultE1M = config.fraud.order.E1M;

    after(() => {
      config.fraud.order.E1M = defaultE1M;
    });

    it('should pass if email stats are below treshold', async () => {
      await expect(checkEmail('crook@tempmail.com')).to.be.fulfilled;
    });

    it('should throw if email stats hit the treshold', async () => {
      config.fraud.order.E1M = '[[5, 0.8, 0.2]]';
      await expect(checkEmail('crook@tempmail.com')).to.be.rejectedWith('above treshold');
    });

    it('should throw if domain stats hit the treshold', async () => {
      config.fraud.order.E1M = '[[5, 0.8, 0.2]]';
      await expect(checkEmail('%@tempmail.com')).to.be.rejectedWith('above treshold');
    });
  });
});
