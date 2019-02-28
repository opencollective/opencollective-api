// Test tools
import { expect } from 'chai';
import * as utils from './utils';
import nock from 'nock';
import sinon from 'sinon';

// Components needed for writing the test
import models from '../server/models';

// What's being tested
import sepa from '../server/paymentProviders/stripe/sepa';
import * as stripeGateway from '../server/paymentProviders/stripe/gateway';

async function createOrderWithPaymentMethod(paymentMethodName) {
  const user = await models.User.createUserWithCollective({
    name: 'TestMcTesterson',
    email: 'tmct@mct.com',
  });
  const host = await models.Collective.create({ name: 'Host Collective' });
  const tier = await models.Tier.create({ name: 'backer' });
  const collective = await models.Collective.create({ name: 'Beaker Browser' });
  collective.addHost(host);
  const connectedAccount = await models.ConnectedAccount.create({
    service: 'stripe',
    token: 'tok_1Be9noDjPFcHOcTmT574CrEv',
    CollectiveId: host.id,
  });
  const paymentMethod = await models.PaymentMethod.create({
    name: paymentMethodName,
    token: 'btok_123456781234567812345678',
    service: 'stripe',
    type: 'sepa',
    monthlyLimitPerMember: 10000,
    CollectiveId: collective.id,
  });
  const order = await models.Order.create({
    CreatedByUserId: user.id,
    FromCollectiveId: user.CollectiveId,
    CollectiveId: collective.id,
    PaymentMethodId: paymentMethod.id,
    TierId: tier.id,
    totalAmount: 1000,
    currency: 'USD',
  });
  order.fromCollective = user.collective;
  order.collective = collective;
  order.createdByUser = user;
  order.paymentMethod = paymentMethod;
  return { order, user, collective, paymentMethod, connectedAccount };
}

describe('stripe.sepa', () => {
  describe('#processOrder()', async () => {
    let secondCallToCreateCustomer;
    let sandbox;

    beforeEach(() => utils.resetTestDB());

    beforeEach(() => {
      sandbox = sinon.createSandbox();

      // Call performed by getOrCreateCustomerOnPlatformAccount
      nock('https://api.stripe.com:443')
        .post('/v1/customers')
        .reply(200, {});

      // Calls performed by getOrCreateCustomerIdForHost
      secondCallToCreateCustomer = nock('https://api.stripe.com:443')
        .post('/v1/customers')
        .reply(200, {});
      nock('https://api.stripe.com:443')
        .post('/v1/tokens')
        .reply(200, {});

      // Calls performed by createChargeAndTransactions
      nock('https://api.stripe.com:443')
        .post('/v1/charges')
        .reply(200, {
          id: 'ch_1B5j91D8MNtzsDcgNMsUgI8L',
          balance_transaction: 'txn_1B5j92D8MNtzsDcgQzIcmfrn',
        });
      nock('https://api.stripe.com:443')
        .get('/v1/balance/history/txn_1B5j92D8MNtzsDcgQzIcmfrn')
        .reply(200, { amount: 1000, fee: 0, fee_details: [] });
    });

    afterEach(() => {
      nock.cleanAll();
      sandbox.restore();
    });

    it('should not create a new customer id for a host for pre-migration users', async () => {
      const { order } = await createOrderWithPaymentMethod(null);
      await sepa.processOrder(order);
      expect(secondCallToCreateCustomer.isDone()).to.be.false;
    });

    it('should create a new customer id for a host for post-migration users', async () => {
      const { order } = await createOrderWithPaymentMethod('name');
      await sepa.processOrder(order);
      expect(secondCallToCreateCustomer.isDone()).to.be.true;
    });

    it('should include OrderId to charge metadata', async () => {
      const { order } = await createOrderWithPaymentMethod('name');
      const createCharge = sandbox.spy(stripeGateway, 'createCharge');
      await sepa.processOrder(order);
      expect(createCharge.firstCall)
        .to.have.nested.property('lastArg.metadata.OrderId')
        .to.be.equal(order.id);
    });
  });
});
