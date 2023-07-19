/* eslint-disable camelcase */

import { expect } from 'chai';
import config from 'config';
import { assert, createSandbox } from 'sinon';

import { Service } from '../../../../server/constants/connected_account.js';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods.js';
import stripe from '../../../../server/lib/stripe.js';
import * as common from '../../../../server/paymentProviders/stripe/common.js';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeOrder,
  fakePaymentMethod,
  fakeUser,
} from '../../../test-helpers/fake-data.js';
import * as utils from '../../../utils.js';

describe('server/paymentProviders/stripe/common', () => {
  describe('#getOrCreateStripeCustomer()', async () => {
    beforeEach(() => utils.resetTestDB());

    const sandbox = createSandbox();
    afterEach(sandbox.restore);

    let collective, user;
    beforeEach(async () => {
      user = await fakeUser();
      collective = await fakeCollective();
      sandbox.stub(stripe.customers, 'create');
    });

    it('creates a new customer on stripe if one does not exist', async () => {
      stripe.customers.create.resolves({ id: 'cus_test' });

      const stripeCustomer = await common.getOrCreateStripeCustomer('acc_test', collective, user);

      expect(stripeCustomer).to.equal('cus_test');
      assert.calledWithMatch(stripe.customers.create, { email: user.email }, { stripeAccount: 'acc_test' });
    });

    it('returns existing customer', async () => {
      await fakeConnectedAccount({
        CollectiveId: collective.id,
        service: Service.STRIPE_CUSTOMER,
        username: 'cus_test',
        clientId: 'acc_test',
      });

      const stripeCustomer = await common.getOrCreateStripeCustomer('acc_test', collective, user);

      expect(stripeCustomer).to.equal('cus_test');
      assert.notCalled(stripe.customers.create);
    });
  });

  describe('#getOrClonePaymentMethod()', async () => {
    beforeEach(() => utils.resetTestDB());

    const sandbox = createSandbox();
    afterEach(sandbox.restore);

    let collective, platformPaymentMethod;
    beforeEach(async () => {
      collective = await fakeCollective();

      platformPaymentMethod = await fakePaymentMethod({
        customerId: 'cus_platformcardcustomer',
        token: 'tok_platformcardtoken1234567',
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        CollectiveId: collective.id,
      });

      sandbox.stub(stripe.tokens, 'retrieve');
      sandbox.stub(stripe.paymentMethods, 'create');
      sandbox.stub(stripe.paymentMethods, 'attach');
    });

    it('clones the card payment method if not cloned already', async () => {
      stripe.tokens.retrieve.resolves({
        id: 'tok_platformcardtoken1234567',
        card: {
          id: 'card_platform',
          fingerprint: 'fingerprint',
        },
      });

      stripe.paymentMethods.create.resolves({
        id: 'pm_aclonedcardinhostaccount',
      });

      stripe.paymentMethods.attach.resolves({
        id: 'pm_aclonedcardinhostaccount',
        type: 'card',
        card: {
          fingerprint: 'fingerprint',
        },
      });

      const paymentMethod = await common.getOrCloneCardPaymentMethod(
        platformPaymentMethod,
        collective,
        'acc_host_test',
        'cus_host_test',
      );

      expect(paymentMethod).to.exist;
      expect(paymentMethod.customer).to.equal('cus_host_test');
      expect(paymentMethod.id).to.equal('pm_aclonedcardinhostaccount');

      assert.calledWithMatch(stripe.tokens.retrieve, platformPaymentMethod.token);
      assert.calledWithMatch(
        stripe.paymentMethods.create,
        { customer: platformPaymentMethod.customerId, payment_method: 'card_platform' },
        { stripeAccount: 'acc_host_test' },
      );

      assert.calledWithMatch(
        stripe.paymentMethods.attach,
        'pm_aclonedcardinhostaccount',
        { customer: 'cus_host_test' },
        { stripeAccount: 'acc_host_test' },
      );
    });

    it('return card payment method already cloned', async () => {
      await platformPaymentMethod.update({
        data: {
          ...platformPaymentMethod.data,
          fingerprint: 'fingerprint',
          stripePaymentMethodId: 'card_platform',
          stripePaymentMethodByHostCustomer: {
            cus_host_test: 'pm_aclonedcardinhostaccount',
          },
        },
      });

      const paymentMethod = await common.getOrCloneCardPaymentMethod(
        platformPaymentMethod,
        collective,
        'acc_host_test',
        'cus_host_test',
      );

      expect(paymentMethod).to.exist;
      expect(paymentMethod.customer).to.equal('cus_host_test');
      expect(paymentMethod.id).to.equal('pm_aclonedcardinhostaccount');

      assert.notCalled(stripe.tokens.retrieve);
      assert.notCalled(stripe.paymentMethods.create);
      assert.notCalled(stripe.paymentMethods.attach);
    });
  });

  describe('#attachCardToPlatformCustomer()', async () => {
    beforeEach(() => utils.resetTestDB());

    const sandbox = createSandbox();
    afterEach(sandbox.restore);

    let collective, paymentMethod, user;
    beforeEach(async () => {
      collective = await fakeCollective();
      user = await fakeUser();

      paymentMethod = await fakePaymentMethod({
        customerId: undefined,
        token: 'tok_platformcardtoken1234567',
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        CollectiveId: collective.id,
      });

      sandbox.stub(stripe.paymentMethods, 'create');
      sandbox.stub(stripe.paymentMethods, 'attach');
    });

    it('attaches card to platform customer account', async () => {
      stripe.paymentMethods.create.resolves({
        id: 'pm_platformcard123456789012',
      });

      stripe.paymentMethods.attach.resolves({
        id: 'pm_platformcard123456789012',
        type: 'card',
        card: {
          fingerprint: 'fingerprint',
        },
      });

      await fakeConnectedAccount({
        clientId: config.stripe.accountId,
        username: 'cus_platform',
        CollectiveId: collective.id,
        service: Service.STRIPE_CUSTOMER,
      });

      paymentMethod = await common.attachCardToPlatformCustomer(paymentMethod, collective, user);

      expect(paymentMethod).to.exist;
      expect(paymentMethod.customerId).to.equal('cus_platform');
      expect(paymentMethod.data?.fingerprint).to.equal('fingerprint');
      expect(paymentMethod.data?.stripePaymentMethodId).to.equal('pm_platformcard123456789012');

      assert.calledWithMatch(stripe.paymentMethods.create, {
        type: 'card',
        card: { token: 'tok_platformcardtoken1234567' },
      });

      assert.calledWithMatch(stripe.paymentMethods.attach, 'pm_platformcard123456789012', { customer: 'cus_platform' });
    });
  });

  describe('#resolvePaymentMethodForOrder()', async () => {
    beforeEach(() => utils.resetTestDB());

    const sandbox = createSandbox();
    afterEach(sandbox.restore);

    let collective, paymentMethod, order;
    beforeEach(async () => {
      collective = await fakeCollective();

      await fakeConnectedAccount({
        clientId: config.stripe.accountId,
        username: 'cus_platformcustomer',
        CollectiveId: collective.id,
        service: Service.STRIPE_CUSTOMER,
      });

      paymentMethod = await fakePaymentMethod({
        customerId: 'cus_platformcustomer',
        token: 'tok_platformcardtoken1234567',
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        CollectiveId: collective.id,
        data: {
          stripePaymentMethodId: 'pm_platformcard123456789012',
          fingerprint: 'fingerprint',
        },
      });

      order = await fakeOrder({
        PaymentMethodId: paymentMethod.id,
        FromCollectiveId: collective.id,
      });

      await fakeConnectedAccount({
        clientId: 'acc_host',
        username: 'cus_hostcustomer',
        CollectiveId: collective.id,
        service: Service.STRIPE_CUSTOMER,
      });

      sandbox.stub(stripe.paymentMethods, 'create');
      sandbox.stub(stripe.paymentMethods, 'attach');
    });

    it('clones card to host account', async () => {
      stripe.paymentMethods.create.resolves({
        id: 'pm_clonedcard12345678901234',
      });

      stripe.paymentMethods.attach.resolves({
        id: 'pm_clonedcard12345678901234',
        type: 'card',
        card: {
          fingerprint: 'fingerprint',
        },
      });

      paymentMethod = await common.resolvePaymentMethodForOrder('acc_host', order);

      expect(paymentMethod).to.exist;
      expect(paymentMethod.customer).to.equal('cus_hostcustomer');
      expect(paymentMethod.id).to.equal('pm_clonedcard12345678901234');

      assert.calledWithMatch(stripe.paymentMethods.create, {
        customer: 'cus_platformcustomer',
        payment_method: 'pm_platformcard123456789012',
      });

      assert.calledWithMatch(stripe.paymentMethods.attach, 'pm_clonedcard12345678901234', {
        customer: 'cus_hostcustomer',
      });
    });

    it('return existing cloned card', async () => {
      await paymentMethod.update({
        data: {
          ...paymentMethod.data,
          stripePaymentMethodByHostCustomer: {
            cus_hostcustomer: 'pm_clonedcard12345678901234',
          },
        },
      });
      order.paymentMethod = paymentMethod;

      paymentMethod = await common.resolvePaymentMethodForOrder('acc_host', order);

      expect(paymentMethod).to.exist;
      expect(paymentMethod.customer).to.equal('cus_hostcustomer');
      expect(paymentMethod.id).to.equal('pm_clonedcard12345678901234');

      assert.notCalled(stripe.paymentMethods.create);
      assert.notCalled(stripe.paymentMethods.attach);
    });

    it('return platform card for platform host', async () => {
      const resolvedPM = await common.resolvePaymentMethodForOrder(config.stripe.accountId, order);

      expect(resolvedPM.id).to.equal(paymentMethod.data.stripePaymentMethodId);

      assert.notCalled(stripe.paymentMethods.create);
      assert.notCalled(stripe.paymentMethods.attach);
    });

    it('return same card if it exists on host account', async () => {
      order.paymentMethod = await fakePaymentMethod({
        customerId: 'cus_hostcustomer',
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        CollectiveId: collective.id,
        data: {
          stripeAccount: 'acc_host',
          stripePaymentMethodId: 'pm_clonedcard12345678901234',
          fingerprint: 'fingerprint',
        },
      });

      const resolvedPM = await common.resolvePaymentMethodForOrder('acc_host', order);

      expect(resolvedPM.id).to.equal(order.paymentMethod.data.stripePaymentMethodId);

      assert.notCalled(stripe.paymentMethods.create);
      assert.notCalled(stripe.paymentMethods.attach);
    });

    it('throws error if card is from another connected account', async () => {
      order.paymentMethod = await fakePaymentMethod({
        customerId: 'cus_anotherhostcustomer',
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        CollectiveId: collective.id,
        data: {
          stripeAccount: 'acc_anotherhost',
          stripePaymentMethodId: 'pm_clonedcard12345678901234',
          fingerprint: 'fingerprint',
        },
      });

      await expect(common.resolvePaymentMethodForOrder('acc_host', order)).to.eventually.be.rejectedWith(
        Error,
        'Cannot clone payment method that are not attached to the platform account',
      );

      assert.notCalled(stripe.paymentMethods.create);
      assert.notCalled(stripe.paymentMethods.attach);
    });

    it('throws error if card is from connected account and host is platform', async () => {
      order.paymentMethod = await fakePaymentMethod({
        customerId: 'cus_hostcustomer',
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        CollectiveId: collective.id,
        data: {
          stripeAccount: 'acc_host',
          stripePaymentMethodId: 'pm_clonedcard12345678901234',
          fingerprint: 'fingerprint',
        },
      });

      await expect(common.resolvePaymentMethodForOrder(config.stripe.accountId, order)).to.eventually.be.rejectedWith(
        Error,
        'Cannot clone payment method from connected account to platform account',
      );

      assert.notCalled(stripe.paymentMethods.create);
      assert.notCalled(stripe.paymentMethods.attach);
    });
  });
});
