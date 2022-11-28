/* eslint-disable camelcase */

import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import OrderStatuses from '../../../../server/constants/order_status';
import stripe from '../../../../server/lib/stripe';
import models from '../../../../server/models';
import paymentIntent from '../../../../server/paymentProviders/stripe/payment-intent';
import { fakeConnectedAccount, fakeOrder, fakePaymentMethod, randStr } from '../../../test-helpers/fake-data';

describe('stripe/payment-intent', () => {
  const sandbox = createSandbox();
  beforeEach(() => {
    sandbox.stub(stripe.paymentIntents, 'update').callsFake((id, intent) => Promise.resolve({ id, ...intent }));
  });
  afterEach(sandbox.restore);

  describe('processOrder', () => {
    let order;

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({ type: 'paymentintent', service: 'stripe' });
      order = await fakeOrder({
        PaymentMethodId: paymentMethod.id,
        FromCollectiveId: paymentMethod.CollectiveId,
        status: 'NEW',
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

    it('set order status to PROCESSING and update data.paymentIntent', async () => {
      await paymentIntent.processOrder(order);

      await order.reload();
      const orderJSON = order.toJSON();
      expect(orderJSON).to.have.nested.property('data.paymentIntent');
      expect(orderJSON).to.have.nested.property('data.paymentIntent.amount');
      expect(orderJSON).to.have.nested.property('data.paymentIntent.description');
      expect(orderJSON).to.have.property('status', OrderStatuses.PROCESSING);
    });

    it('destroys the order if something goes wrong', async () => {
      (stripe.paymentIntents.update as any).throws();
      const processOrder = paymentIntent.processOrder(order);
      await expect(processOrder).to.be.eventually.rejectedWith(Error);

      order = await models.Order.findByPk(order.id);
      expect(order).to.be.null;
    });
  });
});
