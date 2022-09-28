import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import { run as runCronJob } from '../../../cron/hourly/70-cancel-subscriptions-for-cancelled-orders';
import * as PaypalAPI from '../../../server/paymentProviders/paypal/api';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  randStr,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const fakePayPalSubscriptionOrder = async collective => {
  const paypalSubscriptionId = randStr();
  const paymentMethod = await fakePaymentMethod({
    service: 'paypal',
    type: 'subscription',
    token: paypalSubscriptionId,
  });
  return fakeOrder(
    {
      CollectiveId: collective.id,
      interval: 'month',
      status: 'ACTIVE',
      TierId: null,
      totalAmount: 1000,
      subscription: { paypalSubscriptionId, isActive: true, isManagedExternally: true },
      PaymentMethodId: paymentMethod.id,
    },
    {
      withSubscription: true,
      withTransactions: true,
    },
  );
};

describe('cron/hourly/70-cancel-subscriptions-for-cancelled-orders', () => {
  let sandbox, host;

  before(async () => {
    await resetTestDB();
    host = await fakeHost();
    await fakeConnectedAccount({ service: 'paypal', clientId: randStr(), token: randStr(), CollectiveId: host.id });
    sandbox = createSandbox();
  });

  after(() => {
    sandbox.restore();
  });

  it('does nothing if there is no order to cancel', async () => {
    // Active collective with active subscriptions...
    const collective = await fakeCollective({ isActive: true, deactivatedAt: null });
    const order = await fakePayPalSubscriptionOrder(collective);
    await runCronJob();

    // ... should not trigger any change
    await order.reload();
    expect(order.status).to.eq('ACTIVE');
    expect(order.Subscription.isActive).to.be.true;
  });

  it('cancels active recurring PayPal contributions', async () => {
    const host = await fakeHost();
    const collective = await fakeCollective({
      isActive: true,
      deactivatedAt: null,
      HostCollectiveId: host.id,
      slug: 'test-collective',
    });
    const order = await fakePayPalSubscriptionOrder(collective);

    // PayPal API stubs
    const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
    const subscriptionUrl = `billing/subscriptions/${order.paymentMethod.token}`;
    paypalRequestStub.resolves();

    // Archived collective with active subscriptions...
    await collective.update({ isActive: false, deactivatedAt: Date.now(), approvedAt: null, HostCollectiveId: null });
    await runCronJob();

    // ... should trigger the cancellation
    assert.calledOnce(paypalRequestStub);
    const paypalRequest = paypalRequestStub.getCall(0);
    expect(paypalRequest.args[0]).to.eq(`${subscriptionUrl}/cancel`);
    expect(paypalRequest.args[1].reason).to.eq(`@test-collective archived their account`);
    expect(paypalRequest.args[2].id).to.eq(host.id);

    await order.reload();
    await order.Subscription.reload();
    expect(order.status).to.eq('CANCELLED');
    expect(order.Subscription.isActive).to.be.false;
  });
});
