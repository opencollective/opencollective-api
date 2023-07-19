import { expect } from 'chai';
import config from 'config';
import type Express from 'express';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods.js';
import {
  checkEmail,
  checkIP,
  checkUser,
  getEmailStats,
  getIpStats,
  getUserStats,
  orderFraudProtection,
} from '../../../../server/lib/security/order.js';
import { fakeOrder, fakePaymentMethod, fakeUser, multiple } from '../../../test-helpers/fake-data.js';
import { resetTestDB } from '../../../utils.js';

describe('lib/security/order', () => {
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

      it('should pass if user stats are below treshold', async () => {
        await expect(checkUser(user)).to.be.fulfilled;
      });

      it('should throw if user stats hit the treshold', async () => {
        config.fraud.order.user = '[["1 month", 5, 0.8, 0.2]]';
        await expect(checkUser(user)).to.be.rejectedWith('above treshold');
      });
    });

    describe('checkIP', () => {
      const defaultip = config.fraud.order.ip;

      after(() => {
        config.fraud.order.ip = defaultip;
      });

      it('should pass if ip stats are below treshold', async () => {
        await expect(checkIP('127.0.0.1')).to.be.fulfilled;
      });

      it('should throw if ip stats hit the treshold', async () => {
        config.fraud.order.ip = '[["5 days", 5, 0.8, 0.2]]';
        await expect(checkIP('127.0.0.1')).to.be.rejectedWith('above treshold');
      });
    });

    describe('checkEmail', () => {
      const defaultemail = config.fraud.order.email;

      after(() => {
        config.fraud.order.email = defaultemail;
      });

      it('should pass if email stats are below treshold', async () => {
        await expect(checkEmail('crook@tempmail.com')).to.be.fulfilled;
      });

      it('should throw if email stats hit the treshold', async () => {
        config.fraud.order.email = '[["1 month", 5, 0.8, 0.2]]';
        await expect(checkEmail('crook@tempmail.com')).to.be.rejectedWith('above treshold');
      });
    });
  });

  describe('orderFraudProtection', () => {
    const defaultFraudConfig = config.fraud;

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
          status: 'ERROR',
          PaymentMethodId: pm.id,
        });

        await expect(orderFraudProtection({ ip: '1.1.1.1' } as Express.Request, {})).to.be.rejectedWith(
          'IP 1.1.1.1 failed fraud protection',
        );
      });

      it('should throw if IP is alredy suspended', async () => {
        await expect(orderFraudProtection({ ip: '1.1.1.1' } as Express.Request, {})).to.be.rejectedWith(
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
        await multiple(fakeOrder, 5, { status: 'ERROR', PaymentMethodId: pm.id, CreatedByUserId: remoteUser.id });
        await expect(orderFraudProtection({ remoteUser } as Express.Request, {})).to.be.rejectedWith(
          'failed fraud protection',
        );
      });

      it('should throw if user is alredy suspended', async () => {
        await expect(orderFraudProtection({ remoteUser } as Express.Request, {})).to.be.rejectedWith(
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
        await expect(orderFraudProtection({} as Express.Request, order)).to.be.rejectedWith(
          'willem@dafoe.com failed fraud protection',
        );
      });

      it('should throw if user email is already suspended', async () => {
        await expect(orderFraudProtection({} as Express.Request, order)).to.be.rejectedWith(
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
        await expect(orderFraudProtection({} as Express.Request, order)).to.be.rejectedWith(
          'Credit Card 4242-Visa-13-2022 failed fraud protection',
        );
      });

      it('should throw if user email is already suspended', async () => {
        await expect(orderFraudProtection({} as Express.Request, order)).to.be.rejectedWith('CREDIT_CARD is suspended');
      });
    });
  });
});
