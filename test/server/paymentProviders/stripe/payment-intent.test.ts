/* eslint-disable camelcase */

import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import { Service } from '../../../../server/constants/connected_account.js';
import OrderStatuses from '../../../../server/constants/order_status.js';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods.js';
import stripe from '../../../../server/lib/stripe.js';
import models from '../../../../server/models/index.js';
import paymentIntent from '../../../../server/paymentProviders/stripe/payment-intent.js';
import { fakeConnectedAccount, fakeOrder, fakePaymentMethod, randStr } from '../../../test-helpers/fake-data.js';
import * as utils from '../../../utils.js';

describe('stripe/payment-intent', () => {
  before(utils.resetTestDB);

  describe('processOrder', () => {
    describe('new order', () => {
      let order;

      const sandbox = createSandbox();
      beforeEach(() => {
        sandbox.stub(stripe.paymentIntents, 'update').callsFake((id, intent) => Promise.resolve({ id, ...intent }));
      });
      afterEach(sandbox.restore);

      beforeEach(async () => {
        const paymentMethod = await fakePaymentMethod({
          type: PAYMENT_METHOD_TYPE.PAYMENT_INTENT,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
        });
        order = await fakeOrder({
          PaymentMethodId: paymentMethod.id,
          FromCollectiveId: paymentMethod.CollectiveId,
          status: OrderStatuses.NEW,
          totalAmount: 100e2,
          description: 'Do you even donate, brah?!',

          data: { paymentIntent: { id: randStr('pi_fake') } },
        });
        const hostId = order.collective.HostCollectiveId;
        await fakeConnectedAccount({
          CollectiveId: hostId,
          service: 'stripe',
          username: 'testUserName',
          token: 'faketoken',
        });
      });

      it('updates paymentIntent with correct amount and currency', async () => {
        await paymentIntent.processOrder(order);

        assert.calledWithMatch(
          stripe.paymentIntents.update,
          order.data.paymentIntent.id,
          { currency: order.currency, amount: order.totalAmount, description: order.description },
          { stripeAccount: 'testUserName' },
        );
      });

      it('updates paymentIntent applicationFee if there is platform tips', async () => {
        await order.update({ platformTipAmount: 100 });
        await paymentIntent.processOrder(order);

        assert.calledWithMatch(
          stripe.paymentIntents.update,
          order.data.paymentIntent.id,
          {
            currency: order.currency,
            amount: order.totalAmount,
            description: order.description,
            application_fee_amount: 100,
          },
          { stripeAccount: 'testUserName' },
        );
      });

      it('set order status to NEW and update data.paymentIntent', async () => {
        await paymentIntent.processOrder(order);

        await order.reload();
        const orderJSON = order.toJSON();
        expect(orderJSON).to.have.nested.property('data.paymentIntent');
        expect(orderJSON).to.have.nested.property('data.paymentIntent.amount');
        expect(orderJSON).to.have.nested.property('data.paymentIntent.description');
        expect(orderJSON).to.have.property('status', OrderStatuses.NEW);
      });

      it('destroys the order if something goes wrong', async () => {
        (stripe.paymentIntents.update as any).throws();
        const processOrder = paymentIntent.processOrder(order);
        await expect(processOrder).to.be.eventually.rejectedWith(Error);

        order = await models.Order.findByPk(order.id);
        expect(order).to.be.null;
      });
    });

    describe('recurring orders', () => {
      let order;
      let stripePaymentMethodId;

      const sandbox = createSandbox();
      afterEach(sandbox.restore);

      beforeEach(async () => {
        stripePaymentMethodId = randStr('pm_');
        const paymentMethod = await fakePaymentMethod({
          type: PAYMENT_METHOD_TYPE.US_BANK_ACCOUNT,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          customerId: 'cus_test',
          data: {
            stripePaymentMethodId,
          },
        });
        order = await fakeOrder(
          {
            PaymentMethodId: paymentMethod.id,
            FromCollectiveId: paymentMethod.CollectiveId,
            status: OrderStatuses.ACTIVE,
            totalAmount: 100e2,
            description: 'Recurring contribution',
          },
          { withSubscription: true },
        );
        const hostId = order.collective.HostCollectiveId;
        await fakeConnectedAccount({
          CollectiveId: hostId,
          service: Service.STRIPE,
          username: 'testUserName',
          token: 'faketoken',
        });
      });

      it('creates and confirms a payment intent', async () => {
        const paymentIntentId = 'pi_test';
        sandbox.stub(stripe.paymentIntents, 'create').resolves({ id: paymentIntentId });
        sandbox.stub(stripe.paymentIntents, 'confirm').resolves({ id: paymentIntentId, status: 'processing' });

        await paymentIntent.processOrder(order);

        expect(order.data.paymentIntent).to.eql({ id: paymentIntentId, status: 'processing' });

        assert.calledWithMatch(
          stripe.paymentIntents.create,
          {
            currency: 'USD',
            amount: 10000,
            description: 'Recurring contribution',
            payment_method_types: ['us_bank_account'],
            payment_method: stripePaymentMethodId,
            customer: 'cus_test',
          },
          { stripeAccount: 'testUserName' },
        );

        assert.calledWithMatch(stripe.paymentIntents.confirm, paymentIntentId, { stripeAccount: 'testUserName' });
      });

      it('throws error if create payment intent fails', async () => {
        const paymentIntentId = 'pi_test';
        sandbox.stub(stripe.paymentIntents, 'create').rejects(new Error('failed to create payment intent'));
        sandbox.stub(stripe.paymentIntents, 'confirm').resolves({ id: paymentIntentId, status: 'processing' });

        await expect(paymentIntent.processOrder(order)).to.eventually.rejectedWith(
          Error,
          'failed to create payment intent',
        );

        assert.calledWithMatch(
          stripe.paymentIntents.create,
          {
            currency: 'USD',
            amount: 10000,
            description: 'Recurring contribution',
            payment_method_types: ['us_bank_account'],
            payment_method: stripePaymentMethodId,
            customer: 'cus_test',
          },
          { stripeAccount: 'testUserName' },
        );

        assert.notCalled(stripe.paymentIntents.confirm);
      });

      it('throws error if confirm payment intent fails', async () => {
        const paymentIntentId = 'pi_test';
        sandbox.stub(stripe.paymentIntents, 'create').resolves({ id: paymentIntentId });
        sandbox.stub(stripe.paymentIntents, 'confirm').rejects(new Error('failed to confirm payment intent'));

        await expect(paymentIntent.processOrder(order)).to.eventually.rejectedWith(
          Error,
          'failed to confirm payment intent',
        );

        assert.calledWithMatch(
          stripe.paymentIntents.create,
          {
            currency: 'USD',
            amount: 10000,
            description: 'Recurring contribution',
            payment_method_types: ['us_bank_account'],
            payment_method: stripePaymentMethodId,
            customer: 'cus_test',
          },
          { stripeAccount: 'testUserName' },
        );

        assert.calledWithMatch(stripe.paymentIntents.confirm, paymentIntentId);
      });

      it('throws error if payment intent requires action after confirm', async () => {
        const paymentIntentId = 'pi_test';
        sandbox.stub(stripe.paymentIntents, 'create').resolves({ id: paymentIntentId });
        sandbox.stub(stripe.paymentIntents, 'confirm').resolves({ id: paymentIntentId, status: 'requires_action' });

        await expect(paymentIntent.processOrder(order)).to.eventually.rejectedWith(
          Error,
          'Error processing Stripe Payment Intent: Something went wrong with the payment, please contact support@opencollective.com.',
        );

        expect(order.data.paymentIntent).to.eql({ id: paymentIntentId, status: 'requires_action' });

        assert.calledWithMatch(
          stripe.paymentIntents.create,
          {
            currency: 'USD',
            amount: 10000,
            description: 'Recurring contribution',
            payment_method_types: ['us_bank_account'],
            payment_method: stripePaymentMethodId,
            customer: 'cus_test',
          },
          { stripeAccount: 'testUserName' },
        );

        assert.calledWithMatch(stripe.paymentIntents.confirm, paymentIntentId);
      });
    });
  });
});
