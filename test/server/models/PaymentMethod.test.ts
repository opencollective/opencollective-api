import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { useFakeTimers } from 'sinon';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import models from '../../../server/models';
import { randEmail } from '../../stores';
import * as utils from '../../utils';

describe('server/models/PaymentMethod', () => {
  let timer, user, collective, organization, paymentMethod;

  before(async () => {
    nock('https://data.fixer.io')
      .get(/.*/)
      .query({ access_key: config.fixer.accessKey, base: 'EUR', symbols: 'USD' }) // eslint-disable-line camelcase
      .reply(200, { base: 'EUR', date: '2017-09-01', rates: { USD: 1.192 } });
    await utils.resetTestDB();
    timer = useFakeTimers({ now: new Date('2017-09-01 00:00:00').getTime(), toFake: ['Date'] });
  });
  after(() => {
    timer.restore();
    nock.cleanAll();
  });

  describe('validation', () => {
    it('validates the token for Stripe', done => {
      models.PaymentMethod.create({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        token: 'invalid token',
      }).catch(e => {
        expect(e.message).to.equal('Invalid Stripe token invalid token');
        done();
      });
    });

    it('requires a token for payment methods that need one', async () => {
      const tokenRequired = [
        { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.CREDITCARD },
        { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.US_BANK_ACCOUNT },
        { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.SEPA_DEBIT },
        { service: PAYMENT_METHOD_SERVICE.PAYPAL, type: PAYMENT_METHOD_TYPE.ADAPTIVE },
        { service: PAYMENT_METHOD_SERVICE.PAYPAL, type: PAYMENT_METHOD_TYPE.SUBSCRIPTION },
      ];

      for (const { service, type } of tokenRequired) {
        await expect(models.PaymentMethod.create({ service, type, token: null })).to.be.rejectedWith(
          `${service} payment method requires a token`,
        );
      }
    });

    it('allows payment methods that are legitimately created without a token', async () => {
      const tokenless = [
        { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.COLLECTIVE },
        { service: PAYMENT_METHOD_SERVICE.PAYPAL, type: PAYMENT_METHOD_TYPE.PAYMENT },
        { service: PAYMENT_METHOD_SERVICE.PAYPAL, type: PAYMENT_METHOD_TYPE.PAYOUT },
        { service: PAYMENT_METHOD_SERVICE.WISE, type: PAYMENT_METHOD_TYPE.BANK_TRANSFER },
        { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.VIRTUAL_CARD },
        { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.MANUAL },
        { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.PAYMENT_INTENT },
      ];

      for (const { service, type } of tokenless) {
        const pm = await models.PaymentMethod.create({ service, type, token: null, currency: 'USD' });
        expect(pm.id).to.exist;
      }
    });
  });

  describe('instance methods', () => {
    before('create a user', () =>
      models.User.createUserWithCollective({
        email: randEmail(),
        name: 'Xavier',
      }).then(u => (user = u)),
    );
    before('create a collective', () =>
      models.Collective.create({
        name: 'BrusselsTogether',
        currency: 'EUR',
      }).then(c => (collective = c)),
    );
    before('create an organization', () =>
      models.Collective.create({ name: 'pubnub', currency: 'USD' }).then(o => (organization = o)),
    );
    before('create a payment method', () =>
      models.PaymentMethod.create({
        name: '4242',
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        token: 'tok_123456781234567812345678',
        CollectiveId: organization.id,
        monthlyLimitPerMember: 10000,
      }).then(pm => (paymentMethod = pm)),
    );
    before('create many transactions', () =>
      models.Transaction.createMany(
        [
          { netAmountInCollectiveCurrency: -500 },
          { netAmountInCollectiveCurrency: -200 },
          { netAmountInCollectiveCurrency: -1000 },
        ],
        {
          CreatedByUserId: user.id,
          FromCollectiveId: collective.id,
          CollectiveId: organization.id,
          PaymentMethodId: paymentMethod.id,
          currency: collective.currency,
          HostCollectiveId: collective.id,
          type: 'DEBIT',
        },
      ),
    );

    it("computes the balance in the currency of the payment method's collective", async () => {
      const balance = await paymentMethod.getBalanceForUser(user);
      expect(balance.currency).to.equal(organization.currency);
      expect(balance.amount).to.equal(7974); // $100 - (€5 + €2 + €10)
    });
  });
});
