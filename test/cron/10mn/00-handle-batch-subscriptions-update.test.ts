import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import { run as runCronJob } from '../../../cron/10mn/00-handle-batch-subscriptions-update';
import { activities } from '../../../server/constants';
import OrderStatuses from '../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import * as SentryLib from '../../../server/lib/sentry';
import models, { Collective, Order } from '../../../server/models';
import * as PaypalAPI from '../../../server/paymentProviders/paypal/api';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTier,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const fakePayPalSubscriptionOrder = async (collective: Collective, orderData: Order['data'] = {}) => {
  const paypalSubscriptionId = randStr();
  const paymentMethod = await fakePaymentMethod({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    token: paypalSubscriptionId,
  });
  return fakeOrder(
    {
      CollectiveId: collective.id,
      interval: 'month',
      status: OrderStatuses.ACTIVE,
      totalAmount: 1000,
      subscription: { paypalSubscriptionId, isActive: true, isManagedExternally: true },
      PaymentMethodId: paymentMethod.id,
      data: orderData,
    },
    {
      withTier: true,
      withSubscription: true,
      withTransactions: true,
    },
  );
};

const fakeStripeSubscriptionOrder = async (collective: Collective, orderData: Order['data'] = {}) => {
  const paymentMethod = await fakePaymentMethod({
    service: PAYMENT_METHOD_SERVICE.STRIPE,
    type: PAYMENT_METHOD_TYPE.CREDITCARD,
  });
  return fakeOrder(
    {
      CollectiveId: collective.id,
      interval: 'month',
      status: OrderStatuses.ACTIVE,
      totalAmount: 1000,
      subscription: { isActive: true, isManagedExternally: false },
      PaymentMethodId: paymentMethod.id,
      data: orderData,
    },
    {
      withTier: true,
      withSubscription: true,
      withTransactions: true,
    },
  );
};

describe('cron/10mn/00-handle-batch-subscriptions-update', () => {
  let sandbox, host;

  beforeEach(async () => {
    await resetTestDB();
    host = await fakeHost();
    await fakeConnectedAccount({ service: 'paypal', clientId: randStr(), token: randStr(), CollectiveId: host.id });
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('cancels paypal subscriptions', async () => {
    const unhostedCollective = await fakeCollective({ HostCollectiveId: host.id, slug: 'test-collective' });
    const paypalOrder = await fakePayPalSubscriptionOrder(unhostedCollective, { needsAsyncDeactivation: true });
    // clear collective balance
    await fakeTransaction({ CollectiveId: unhostedCollective.id, amount: -1000 });
    await unhostedCollective.changeHost(null);

    // PayPal API stubs
    const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
    const subscriptionUrl = `billing/subscriptions/${paypalOrder.paymentMethod.token}`;
    paypalRequestStub.resolves();

    await runCronJob();

    // ... should trigger the cancellation
    assert.calledOnce(paypalRequestStub);
    const paypalRequest = paypalRequestStub.getCall(0);
    expect(paypalRequest.args[0]).to.eq(`${subscriptionUrl}/cancel`);
    expect(paypalRequest.args[1].reason).to.eq(
      `Your contribution to the Collective was paused. We'll inform you when it will be ready for re-activation.`,
    );
    expect(paypalRequest.args[2].id).to.eq(host.id);

    await paypalOrder.reload();
    await paypalOrder.Subscription.reload();
    expect(paypalOrder.status).to.eq(OrderStatuses.PAUSED);
    expect(paypalOrder.Subscription.isActive).to.be.false;

    const activity = await models.Activity.findOne({ where: { type: activities.SUBSCRIPTION_PAUSED } });
    expect(activity).to.exist;
    expect(activity.data.reason).to.equal(
      "Your contribution to the Collective was paused. We'll inform you when it will be ready for re-activation.",
    );
    expect(activity.data.reasonCode).to.equal('PAUSED');
  });

  it('cancels subscriptions from canceled orders', async () => {
    const collective = await fakeCollective({ HostCollectiveId: host.id, slug: 'test-collective' });
    const order = await fakeOrder(
      { CollectiveId: collective.id, data: { needsAsyncDeactivation: true } },
      { withSubscription: true, withTransactions: true, withTier: true },
    );

    await order.update({ status: OrderStatuses.CANCELLED });

    await runCronJob();

    await order.reload();
    await order.Subscription.reload();
    expect(order.status).to.eq(OrderStatuses.CANCELLED);
    expect(order.Subscription.isActive).to.be.false;

    const activity = await models.Activity.findOne({ where: { type: activities.SUBSCRIPTION_CANCELED } });
    expect(activity).to.exist;
    expect(activity.data.reason).to.equal('Order cancelled');
    expect(activity.data.reasonCode).to.equal('CANCELLED_ORDER');
  });

  it('cancels subscriptions from deleted tier', async () => {
    const collective = await fakeCollective({ HostCollectiveId: host.id, slug: 'test-collective' });
    const tier = await fakeTier({ CollectiveId: collective.id });
    const order = await fakeOrder(
      {
        CollectiveId: collective.id,
        TierId: tier.id,
        status: OrderStatuses.ACTIVE,
        data: { needsAsyncDeactivation: true },
      },
      { withSubscription: true, withTransactions: true, withTier: true },
    );

    await models.Order.cancelActiveOrdersByTierId(tier.id);
    await tier.destroy();

    await runCronJob();

    await order.reload();
    await order.Subscription.reload();
    expect(order.status).to.eq(OrderStatuses.CANCELLED);
    expect(order.Subscription.isActive).to.be.false;

    const activity = await models.Activity.findOne({ where: { type: activities.SUBSCRIPTION_CANCELED } });
    expect(activity).to.exist;
    expect(activity.data.reason).to.equal('Order tier deleted');
    expect(activity.data.reasonCode).to.equal('DELETED_TIER');
  });

  it('cancels paypal subscriptions from changed host', async () => {
    const collective = await fakeCollective({ HostCollectiveId: host.id, slug: 'test-collective' });
    const paypalOrder = await fakePayPalSubscriptionOrder(collective);
    // clear collective balance
    await fakeTransaction({ CollectiveId: collective.id, amount: -1000 });

    const newHostAdmin = await fakeUser();
    const newHost = await fakeHost({ admin: newHostAdmin });
    await collective.changeHost(newHost.id, newHostAdmin);

    // PayPal API stubs
    const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
    const subscriptionUrl = `billing/subscriptions/${paypalOrder.paymentMethod.token}`;
    paypalRequestStub.resolves();

    await runCronJob();

    // ... should trigger the cancellation
    assert.calledOnce(paypalRequestStub);
    const paypalRequest = paypalRequestStub.getCall(0);
    expect(paypalRequest.args[0]).to.eq(`${subscriptionUrl}/cancel`);
    expect(paypalRequest.args[1].reason).to.eq(
      "Your contribution to the Collective was paused. We'll inform you when it will be ready for re-activation.",
    );
    expect(paypalRequest.args[2].id).to.eq(host.id);

    await paypalOrder.reload();
    await paypalOrder.Subscription.reload();
    expect(paypalOrder.status).to.eq(OrderStatuses.PAUSED);
    expect(paypalOrder.Subscription.isActive).to.be.false;

    const activity = await models.Activity.findOne({ where: { type: activities.SUBSCRIPTION_PAUSED } });
    expect(activity).to.exist;
    expect(activity.data.reason).to.equal(
      "Your contribution to the Collective was paused. We'll inform you when it will be ready for re-activation.",
    );
    expect(activity.data.reasonCode).to.equal('PAUSED');
  });

  describe('paused orders (from freezing collectives)', () => {
    it('pauses subscriptions from paused orders', async () => {
      const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest').resolves();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const paypalOrder = await fakePayPalSubscriptionOrder(collective);
      const stripeOrder = await fakeStripeSubscriptionOrder(collective);
      await collective.freeze('We are freezing you', true, 'Sorry contributor, we are freezing the collective');
      await paypalOrder.reload();
      expect(paypalOrder.status).to.eq(OrderStatuses.PAUSED);
      expect(paypalOrder.data.needsAsyncPause).to.be.true;

      // Run CRON job
      const result = await runCronJob();
      expect(result).to.deep.eqInAnyOrder([paypalOrder.id, stripeOrder.id]);

      // Make sure PayPal API was called
      assert.calledOnce(paypalRequestStub);
      const paypalRequest = paypalRequestStub.getCall(0);
      expect(paypalRequest.args[0]).to.eq(`billing/subscriptions/${paypalOrder.paymentMethod.token}/suspend`);
      expect(paypalRequest.args[1].reason).to.eq('Sorry contributor, we are freezing the collective');

      // Check orders statuses
      await paypalOrder.reload();
      await paypalOrder.Subscription.reload();
      expect(paypalOrder.status).to.eq(OrderStatuses.PAUSED);
      expect(paypalOrder.Subscription.isActive).to.be.false;
      expect(paypalOrder.data.needsAsyncPause).to.be.undefined;

      await stripeOrder.reload();
      await stripeOrder.Subscription.reload();
      expect(stripeOrder.status).to.eq(OrderStatuses.PAUSED);
      expect(stripeOrder.Subscription.isActive).to.be.false;
      expect(stripeOrder.data.needsAsyncPause).to.be.undefined;
    });

    it('does not touch the order if PayPal call fails)', async () => {
      const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest').rejects(new Error('Random PayPal failure'));
      const sentryStub = sandbox.stub(SentryLib, 'reportErrorToSentry');
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const activeOrder = await fakePayPalSubscriptionOrder(collective);
      await collective.freeze('We are freezing you', true, 'Sorry contributor, we are freezing the collective');
      await activeOrder.reload();
      expect(activeOrder.status).to.eq(OrderStatuses.PAUSED);
      expect(activeOrder.data.needsAsyncPause).to.be.true;

      // Run CRON job
      const result = await runCronJob();
      expect(result).to.deep.eq([activeOrder.id]);

      // Make sure PayPal API was called
      assert.calledOnce(paypalRequestStub);
      const paypalRequest = paypalRequestStub.getCall(0);
      expect(paypalRequest.args[0]).to.eq(`billing/subscriptions/${activeOrder.paymentMethod.token}/suspend`);

      // Make sure error gets reported
      assert.calledTwice(sentryStub);
      expect(sentryStub.getCall(0).args[0].message).to.eq('Random PayPal failure');
      expect(sentryStub.getCall(1).args[0].message).to.eq('Failed to pause PayPal subscription');

      // Check order status, should remain the same
      await activeOrder.reload();
      await activeOrder.Subscription.reload();
      expect(activeOrder.status).to.eq(OrderStatuses.PAUSED);
      expect(activeOrder.Subscription.isActive).to.be.true;
      expect(activeOrder.data.needsAsyncPause).to.be.true;
    });

    it('resumes contributions that are pending for reactivation', async () => {
      const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest').resolves();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const paypalOrder = await fakePayPalSubscriptionOrder(collective);
      const stripeOrder = await fakeStripeSubscriptionOrder(collective);

      // Freeze
      await collective.freeze('We are freezing you', true, 'Sorry contributor, we are freezing the collective');
      const freezeResult = await runCronJob();
      expect(freezeResult).to.deep.eqInAnyOrder([paypalOrder.id, stripeOrder.id]);
      await paypalOrder.reload();
      await paypalOrder.Subscription.reload();
      expect(paypalOrder.Subscription.isActive).to.be.false;
      expect(paypalOrder.status).to.eq(OrderStatuses.PAUSED);
      expect(paypalOrder.data.needsAsyncPause).to.be.undefined;

      // Unfreeze
      await collective.unfreeze('Welcome back!', 'We are resuming the collective');
      await paypalOrder.reload();
      await paypalOrder.Subscription.reload();
      expect(paypalOrder.data.needsAsyncReactivation).to.be.true;
      expect(paypalOrder.Subscription.isActive).to.be.false;
      expect(paypalOrder.status).to.eq(OrderStatuses.PAUSED);

      // Run CRON job
      const unfreezeResult = await runCronJob();
      expect(unfreezeResult).to.deep.eqInAnyOrder([paypalOrder.id, stripeOrder.id]);

      // Make sure PayPal API was called
      assert.calledTwice(paypalRequestStub); // Once for pause, once for resume
      const paypalResumeRequest = paypalRequestStub.getCall(1);
      expect(paypalResumeRequest.args[0]).to.eq(`billing/subscriptions/${paypalOrder.paymentMethod.token}/activate`);
      expect(paypalResumeRequest.args[1].reason).to.eq('We are resuming the collective');

      // Check orders statuses
      await paypalOrder.reload();
      await paypalOrder.Subscription.reload();
      expect(paypalOrder.status).to.eq(OrderStatuses.ACTIVE);
      expect(paypalOrder.Subscription.isActive).to.be.true;
      expect(paypalOrder.data.needsAsyncReactivation).to.be.undefined;

      await stripeOrder.reload();
      await stripeOrder.Subscription.reload();
      expect(stripeOrder.status).to.eq(OrderStatuses.ACTIVE);
      expect(stripeOrder.Subscription.isActive).to.be.true;
      expect(stripeOrder.data.needsAsyncReactivation).to.be.undefined;
    });
  });

  it('does nothing if there is no order to cancel', async () => {
    const collective = await fakeCollective();
    const order = await fakePayPalSubscriptionOrder(collective);

    const result = await runCronJob();
    expect(result.length).to.eq(0);

    await order.reload();
    expect(order.status).to.eq(OrderStatuses.ACTIVE);
    expect(order.Subscription.isActive).to.be.true;
  });
});
