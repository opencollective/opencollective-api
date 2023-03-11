/* eslint-disable camelcase */

import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import * as PaypalAPI from '../../../../server/paymentProviders/paypal/api';
import { setupPaypalSubscriptionForOrder } from '../../../../server/paymentProviders/paypal/subscription';
import { randEmail } from '../../../stores';
import {
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakePaypalPlan,
  randStr,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const fakePaypalSubscriptionPm = subscription => {
  return fakePaymentMethod({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    token: subscription.id,
  });
};

describe('server/paymentProviders/paypal/subscription', () => {
  let sandbox, host, plan, validSubscriptionParams;

  before(async () => {
    // Create host with PayPal
    await resetTestDB();
    host = await fakeHost();
    await fakeConnectedAccount({ service: 'paypal', clientId: randStr(), token: randStr(), CollectiveId: host.id });
    sandbox = createSandbox();
    plan = await fakePaypalPlan({ product: { CollectiveId: host.id }, amount: 1000, interval: 'month' });
  });

  beforeEach(() => {
    validSubscriptionParams = {
      id: randStr(),
      status: 'APPROVED',
      plan_id: plan.id,
      subscriber: {
        email_address: randEmail(),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('setupPaypalSubscriptionForOrder', () => {
    it('activates the subscription when params are valid', async () => {
      const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
      const order = await fakeOrder({ CollectiveId: host.id, status: 'NEW', TierId: null, totalAmount: 1000 });
      const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
      const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
      paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
      paypalRequestStub.withArgs(`${subscriptionUrl}/activate`).resolves();
      await setupPaypalSubscriptionForOrder(order, paymentMethod);
      assert.calledWith(paypalRequestStub, `${subscriptionUrl}/activate`);
      const createdSubscription = await order.getSubscription();
      expect(createdSubscription.paypalSubscriptionId).to.eq(validSubscriptionParams.id);
      expect(createdSubscription.isActive).to.be.false; // Will be activated when the first payment hits
    });

    describe('subscription matches the contribution', () => {
      it('must be APPROVED', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
        const order = await fakeOrder({ CollectiveId: host.id, status: 'NEW', PaymentMethodId: paymentMethod.id });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns({ ...validSubscriptionParams, status: 'ACTIVE' });
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq('Subscription must be approved to be activated');
        assert.calledOnce(paypalRequestStub); // We only fetch the subscription, not approving it
      });

      it('must have an existing plan', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
        const order = await fakeOrder({ CollectiveId: host.id, status: 'NEW', TierId: null });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns({ ...validSubscriptionParams, plan_id: 'xxxxxxx' });
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq(
          `PayPal plan does not match the subscription (#${validSubscriptionParams.id})`,
        );
        assert.calledOnce(paypalRequestStub); // We only fetch the subscription, not approving it
      });

      it('must have a plan that match amount', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
        const order = await fakeOrder({ CollectiveId: host.id, status: 'NEW', TierId: null, totalAmount: 5000 });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq('The plan amount does not match the order amount');
        assert.calledOnce(paypalRequestStub); // We only fetch the subscription, not approving it
      });
    });

    describe('when a subscription already exists', () => {
      const generateOrderWithSubscription = async () => {
        const paypalSubscriptionId = randStr();
        const paymentMethod = await fakePaypalSubscriptionPm({ ...validSubscriptionParams, id: paypalSubscriptionId });
        return fakeOrder(
          {
            CollectiveId: host.id,
            status: 'NEW',
            TierId: null,
            totalAmount: 1000,
            subscription: { paypalSubscriptionId, isActive: false },
            PaymentMethodId: paymentMethod.id,
          },
          {
            withSubscription: true,
          },
        );
      };

      it('cancels/updates existing subscription', async () => {
        const order = await generateOrderWithSubscription();
        const previousSubscription = order.Subscription;
        const newSubscriptionPm = await fakePaypalSubscriptionPm({ ...validSubscriptionParams, id: randStr() });

        // PayPal API stubs
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const oldSubscriptionUrl = `billing/subscriptions/${order.paymentMethod.token}`;
        const subscriptionUrl = `billing/subscriptions/${newSubscriptionPm.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
        paypalRequestStub.withArgs(`${subscriptionUrl}/activate`).resolves();
        paypalRequestStub.withArgs(`${oldSubscriptionUrl}/cancel`).resolves();

        await setupPaypalSubscriptionForOrder(order, newSubscriptionPm);
        assert.calledWith(paypalRequestStub, subscriptionUrl);
        assert.calledWith(paypalRequestStub, `${subscriptionUrl}/activate`);
        assert.calledWith(paypalRequestStub, `${oldSubscriptionUrl}/cancel`);

        const updatedSubscription = await order.getSubscription();
        expect(updatedSubscription.paypalSubscriptionId).to.eq(newSubscriptionPm.token);
        expect(previousSubscription.isActive).to.be.false;
        expect(updatedSubscription.id).to.eq(previousSubscription.id);
      });

      it('does nothing if cancellation fails', async () => {
        const order = await generateOrderWithSubscription();
        const newSubscriptionPm = await fakePaypalSubscriptionPm({ ...validSubscriptionParams, id: randStr() });

        // PayPal API stubs
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const oldSubscriptionUrl = `billing/subscriptions/${order.paymentMethod.token}`;
        const subscriptionUrl = `billing/subscriptions/${newSubscriptionPm.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
        paypalRequestStub.withArgs(`${subscriptionUrl}/activate`).resolves();
        paypalRequestStub.withArgs(`${oldSubscriptionUrl}/cancel`).rejects();

        await expect(setupPaypalSubscriptionForOrder(order, newSubscriptionPm)).to.be.rejected;
        assert.calledWith(paypalRequestStub, subscriptionUrl);
        assert.calledWith(paypalRequestStub, `${oldSubscriptionUrl}/cancel`);
        assert.callCount(paypalRequestStub, 2); // Must NOT call activate if cancellation fails
      });
    });
  });
});
