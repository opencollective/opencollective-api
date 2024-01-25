import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import { run as runCronJob } from '../../../cron/hourly/70-cancel-subscriptions-for-cancelled-orders';
import { activities } from '../../../server/constants';
import OrderStatuses from '../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import models from '../../../server/models';
import * as PaypalAPI from '../../../server/paymentProviders/paypal/api';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeSubscription,
  fakeTier,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const fakePayPalSubscriptionOrder = async collective => {
  const paypalSubscriptionId = randStr();
  const paymentMethod = await fakePaymentMethod({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    token: paypalSubscriptionId,
  });
  const subscription = await fakeSubscription({ paypalSubscriptionId, isActive: true, isManagedExternally: true });
  return fakeOrder(
    {
      CollectiveId: collective.id,
      interval: 'month',
      status: OrderStatuses.ACTIVE,
      totalAmount: 1000,
      subscription,
      PaymentMethodId: paymentMethod.id,
    },
    {
      withTier: true,
      withSubscription: true,
      withTransactions: true,
    },
  );
};

describe('cron/hourly/70-cancel-subscriptions-for-cancelled-orders', () => {
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
    const paypalOrder = await fakePayPalSubscriptionOrder(unhostedCollective);
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
    expect(paypalRequest.args[1].reason).to.eq(`@test-collective was un-hosted`);
    expect(paypalRequest.args[2].id).to.eq(host.id);

    await paypalOrder.reload();
    await paypalOrder.subscription.reload();
    expect(paypalOrder.status).to.eq(OrderStatuses.CANCELLED);
    expect(paypalOrder.subscription.isActive).to.be.false;

    const activity = await models.Activity.findOne({ where: { type: activities.SUBSCRIPTION_CANCELED } });
    expect(activity).to.exist;
    expect(activity.data.reason).to.equal('@test-collective was un-hosted');
    expect(activity.data.reasonCode).to.equal('UNHOSTED_COLLECTIVE');
  });

  it('cancels subscriptions from canceled orders', async () => {
    const collective = await fakeCollective({ HostCollectiveId: host.id, slug: 'test-collective' });
    const order = await fakeOrder(
      { CollectiveId: collective.id },
      { withSubscription: true, withTransactions: true, withTier: true },
    );

    await order.update({ status: OrderStatuses.CANCELLED });

    await runCronJob();

    await order.reload();
    await order.subscription.reload();
    expect(order.status).to.eq(OrderStatuses.CANCELLED);
    expect(order.subscription.isActive).to.be.false;

    const activity = await models.Activity.findOne({ where: { type: activities.SUBSCRIPTION_CANCELED } });
    expect(activity).to.exist;
    expect(activity.data.reason).to.equal('Order cancelled');
    expect(activity.data.reasonCode).to.equal('CANCELLED_ORDER');
  });

  it('cancels subscriptions from deleted tier', async () => {
    const collective = await fakeCollective({ HostCollectiveId: host.id, slug: 'test-collective' });
    const tier = await fakeTier({ CollectiveId: collective.id });
    const order = await fakeOrder(
      { CollectiveId: collective.id, TierId: tier.id, status: OrderStatuses.ACTIVE },
      { withSubscription: true, withTransactions: true, withTier: true },
    );

    await models.Order.cancelActiveOrdersByTierId(tier.id);
    await tier.destroy();

    await runCronJob();

    await order.reload();
    await order.subscription.reload();
    expect(order.status).to.eq(OrderStatuses.CANCELLED);
    expect(order.subscription.isActive).to.be.false;

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
    expect(paypalRequest.args[1].reason).to.eq(`@test-collective changed host`);
    expect(paypalRequest.args[2].id).to.eq(host.id);

    await paypalOrder.reload();
    await paypalOrder.subscription.reload();
    expect(paypalOrder.status).to.eq(OrderStatuses.CANCELLED);
    expect(paypalOrder.subscription.isActive).to.be.false;

    const activity = await models.Activity.findOne({ where: { type: activities.SUBSCRIPTION_CANCELED } });
    expect(activity).to.exist;
    expect(activity.data.reason).to.equal('@test-collective changed host');
    expect(activity.data.reasonCode).to.equal('CHANGED_HOST');
  });

  it('does nothing if there is no order to cancel', async () => {
    const collective = await fakeCollective();
    const order = await fakePayPalSubscriptionOrder(collective);

    await runCronJob();

    await order.reload();
    expect(order.status).to.eq(OrderStatuses.ACTIVE);
    expect(order.subscription.isActive).to.be.true;
  });
});
