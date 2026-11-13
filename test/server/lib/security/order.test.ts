import { expect } from 'chai';
import config from 'config';
import type express from 'express';

import OrderStatuses from '../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import {
  checkEmail,
  checkIP,
  checkUser,
  getEmailStats,
  getIpStats,
  getUserStats,
  orderFraudProtection,
  validateStat,
} from '../../../../server/lib/security/order';
import { fakeOrder, fakePaymentMethod, fakeUser, multiple } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('lib/security/order', () => {
  describe('validateStat', () => {
    const limits = '[["1 hour", 5, 1, 1], ["1 month", 10, 0.8, 0.8]]';
    const emptyStats = { numberOfOrders: 0, errorRate: 0, paymentMethodRate: 0 };

    it('evaluates each limit on its own interval', async () => {
      const intervals = [];
      const statFn = async (_user, interval) => {
        intervals.push(interval);
        return emptyStats;
      };
      await validateStat(statFn, [{ id: 1 }], limits, 'Fraud');
      expect(intervals).to.have.members(['1 hour', '1 month']);
    });

    it('fails when only a later limit is above threshold', async () => {
      const statFn = async (_user, interval) =>
        interval === '1 month' ? { numberOfOrders: 12, errorRate: 1, paymentMethodRate: 1 } : emptyStats;
      let onFailCalled = false;
      const onFail = async () => {
        onFailCalled = true;
      };
      await expect(validateStat(statFn, [{ id: 1 }], limits, 'Fraud', { onFail })).to.be.rejectedWith(
        'above threshold 1 month',
      );
      expect(onFailCalled).to.be.true;
    });
  });

  describe('helper functions', () => {
    let user;
    before(resetTestDB);
    before(async () => {
      user = await fakeUser({ email: 'crook@tempmail.com' });
      const pm = await fakePaymentMethod({
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        CollectiveId: user.collective.id,
        name: '4242',
        data: { expYear: 2022 },
      });
      const defaultOrderProps = {
        CreatedByUserId: user.id,
        PaymentMethodId: pm.id,
        data: { reqIp: '127.0.0.1' },
      };
      await multiple(fakeOrder, 4, { ...defaultOrderProps, status: OrderStatuses.ERROR });
      await multiple(fakeOrder, 1, { ...defaultOrderProps, status: OrderStatuses.PAID });
      // Add Noise
      await multiple(fakeOrder, 5, { status: OrderStatuses.ERROR, PaymentMethodId: pm.id });
      await multiple(fakeOrder, 5, { status: OrderStatuses.PAID, PaymentMethodId: pm.id });
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
    });

    describe('getIpStats', () => {
      it('should return stats for any given IP address', async () => {
        const stats = await getIpStats('127.0.0.1');
        expect(stats).to.have.property('errorRate', 0.8);
        expect(stats).to.have.property('numberOfOrders', 5);
        expect(stats).to.have.property('paymentMethodRate', 0.2);
      });
    });

    describe('checkUser', () => {
      const defaultuser = config.fraud.order.user;

      after(() => {
        config.fraud.order.user = defaultuser;
      });

      it('should pass if user stats are below threshold', async () => {
        await expect(checkUser(user)).to.be.fulfilled;
      });

      it('should throw if user stats hit the threshold', async () => {
        config.fraud.order.user = '[["1 month", 5, 0.8, 0.2]]';
        await expect(checkUser(user)).to.be.rejectedWith('above threshold');
      });
    });

    describe('checkIP', () => {
      const defaultip = config.fraud.order.ip;

      after(() => {
        config.fraud.order.ip = defaultip;
      });

      it('should pass if ip stats are below threshold', async () => {
        await expect(checkIP('127.0.0.1')).to.be.fulfilled;
      });

      it('should throw if ip stats hit the threshold', async () => {
        config.fraud.order.ip = '[["5 days", 5, 0.8, 0.2]]';
        await expect(checkIP('127.0.0.1')).to.be.rejectedWith('above threshold');
      });
    });

    describe('checkEmail', () => {
      const defaultemail = config.fraud.order.email;

      after(() => {
        config.fraud.order.email = defaultemail;
      });

      it('should pass if email stats are below threshold', async () => {
        await expect(checkEmail('crook@tempmail.com')).to.be.fulfilled;
      });

      it('should throw if email stats hit the threshold', async () => {
        config.fraud.order.email = '[["1 month", 5, 0.8, 0.2]]';
        await expect(checkEmail('crook@tempmail.com')).to.be.rejectedWith('above threshold');
      });
    });
  });

  describe('orderFraudProtection', () => {
    const defaultFraudConfig = config.fraud;
    const defaultCardLimits = config.fraud.order.card;

    after(() => {
      config.fraud = defaultFraudConfig;
    });
    before(resetTestDB);

    describe('IP verification', () => {
      it('should throw if it fails IP verification', async () => {
        config.fraud.order.ip = '[["5 days", 3, 1, 0.1]]';
        const pm = await fakePaymentMethod({
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          name: '4242',
          data: { expYear: 2022 },
        });
        await multiple(fakeOrder, 4, {
          data: { reqIp: '1.1.1.1' },
          status: OrderStatuses.ERROR,
          PaymentMethodId: pm.id,
        });

        await expect(orderFraudProtection({ ip: '1.1.1.1' } as express.Request, {})).to.be.rejectedWith(
          'IP 1.1.1.1 failed fraud protection',
        );
      });

      it('should throw if IP is alredy suspended', async () => {
        await expect(orderFraudProtection({ ip: '1.1.1.1' } as express.Request, {})).to.be.rejectedWith(
          'IP is suspended',
        );
      });
    });

    describe('user verification', () => {
      let remoteUser;
      before(async () => {
        remoteUser = await fakeUser({ email: 'willem@dafoe.com' });
        config.fraud.order.user = '[["1 month", 3, 1, 0.2]]';
      });

      it('should throw if it fails User verification', async () => {
        const pm = await fakePaymentMethod({
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          CollectiveId: remoteUser.collective.id,
          name: '4242',
          data: { expYear: 2022, expMonth: 13, country: 'US' },
        });
        await multiple(fakeOrder, 5, {
          status: OrderStatuses.ERROR,
          PaymentMethodId: pm.id,
          CreatedByUserId: remoteUser.id,
        });
        await expect(orderFraudProtection({ remoteUser } as express.Request, {})).to.be.rejectedWith(
          'failed fraud protection',
        );
      });

      it('should throw if user is alredy suspended', async () => {
        await expect(orderFraudProtection({ remoteUser } as express.Request, {})).to.be.rejectedWith(
          'USER is suspended',
        );
      });
    });

    describe('email verification', () => {
      const order = { guestInfo: { email: 'willem@dafoe.com' } };
      before(() => {
        config.fraud.order.email = '[["5 days", 5, 0.8, 0.2]]';
      });

      it('should throw if donation comes from a guest-user from the same email', async () => {
        await expect(orderFraudProtection({} as express.Request, order)).to.be.rejectedWith(
          'willem@dafoe.com failed fraud protection',
        );
      });

      it('should throw if user email is already suspended', async () => {
        await expect(orderFraudProtection({} as express.Request, order)).to.be.rejectedWith(
          'EMAIL_ADDRESS is suspended',
        );
      });
    });

    describe('credit card verification', () => {
      const order = {
        paymentMethod: {
          name: '4242',
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          data: { expYear: 2022, expMonth: 13, brand: 'Visa' },
        },
      };
      before(() => {
        config.fraud.order.card = '[["1 month", 5, 0.8, 0.2]]';
      });

      it('should throw if donation comes from a guest-user from the same email', async () => {
        await expect(orderFraudProtection({} as express.Request, order)).to.be.rejectedWith(
          'Credit Card 4242-Visa-13-2022 failed fraud protection',
        );
      });

      it('should throw if user email is already suspended', async () => {
        await expect(orderFraudProtection({} as express.Request, order)).to.be.rejectedWith('CREDIT_CARD is suspended');
      });
    });

    describe('credit card verification with default thresholds', () => {
      before(() => {
        config.fraud.order.card = defaultCardLimits;
      });

      const createFailedOrders = async (name, data) => {
        const pm = await fakePaymentMethod({
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          name,
          data,
        });
        await multiple(fakeOrder, 10, { status: OrderStatuses.ERROR, PaymentMethodId: pm.id });
        return {
          paymentMethod: { name, type: PAYMENT_METHOD_TYPE.CREDITCARD, service: PAYMENT_METHOD_SERVICE.STRIPE, data },
        };
      };

      it('should throw for a card matched by fingerprint with many failed orders', async () => {
        const data = { expYear: 2030, expMonth: 11, country: 'US', brand: 'Visa', fingerprint: 'fp_failing_card' };
        const order = await createFailedOrders('5555', data);
        await expect(orderFraudProtection({} as express.Request, order)).to.be.rejectedWith(
          'Credit Card fp_failing_card failed fraud protection',
        );
      });

      it('should throw for a card matched by name and expiry with many failed orders', async () => {
        const data = { expYear: 2031, expMonth: 12, country: 'FR', brand: 'Visa' };
        const order = await createFailedOrders('1111', data);
        await expect(orderFraudProtection({} as express.Request, order)).to.be.rejectedWith(
          'Credit Card 1111-Visa-12-2031 failed fraud protection',
        );
      });
    });
  });
});
