import { expect } from 'chai';
import sinon from 'sinon';

import { run as handleBatchSubscriptionsUpdate } from '../../cron/hourly/70-handle-batch-subscriptions-update';
import { main as runShutdownOCFContributions } from '../../scripts/shutdown-ocf-contributions';
import FEATURE from '../../server/constants/feature';
import OrderStatuses from '../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import { getFeatureStatusResolver } from '../../server/graphql/common/features';
import emailLib from '../../server/lib/email';
import * as Utils from '../../server/lib/utils';
import * as PayPalSubscriptionAPI from '../../server/paymentProviders/paypal/subscription';
import { fakeActiveHost, fakeCollective, fakeOrder, fakePaymentMethod } from '../test-helpers/fake-data';
import { makeRequest, resetTestDB } from '../utils';

describe('scripts/shutdown-ocf-contributions', () => {
  let ocf, ocfCollective, ocfStripeOrder, ocfPayPalOrder, randomOrder, sandbox, emailSendMessageSpy;

  before(async () => {
    await resetTestDB(); // To make sure the `foundation` slug is free
    sandbox = sinon.createSandbox();
    ocf = await fakeActiveHost({ slug: 'foundation' });
    ocfCollective = await fakeCollective({ HostCollectiveId: ocf.id, isActive: true, approvedAt: new Date() });

    // Stub defaultHostCollective
    sandbox.stub(Utils, 'defaultHostCollective').withArgs('foundation').returns({ CollectiveId: ocf.id });
    sandbox.stub(PayPalSubscriptionAPI, 'cancelPaypalSubscription').resolves();

    // Stub libs
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');

    // Create some orders
    const paypalPm = await fakePaymentMethod({
      service: PAYMENT_METHOD_SERVICE.PAYPAL,
      type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    });
    const stripePm = await fakePaymentMethod({
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
    });
    ocfPayPalOrder = await fakeOrder(
      {
        totalAmount: 1000,
        CollectiveId: ocfCollective.id,
        status: OrderStatuses.ACTIVE,
        PaymentMethodId: paypalPm.id,
      },
      { withSubscription: true },
    );
    ocfStripeOrder = await fakeOrder(
      {
        totalAmount: 5000,
        CollectiveId: ocfCollective.id,
        status: OrderStatuses.ACTIVE,
        PaymentMethodId: stripePm.id,
      },
      { withSubscription: true },
    );
    randomOrder = await fakeOrder({ status: OrderStatuses.ACTIVE }, { withSubscription: true });
  });

  after(() => {
    sandbox.restore();
  });

  it('sends the correct message to OCF contributors', async () => {
    await runShutdownOCFContributions({ overrideDryRun: true });

    // Make sure OCF collectives can't receive financial contributions
    const req = makeRequest();
    const featureStatusResolver = getFeatureStatusResolver(FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS);
    expect(await featureStatusResolver(ocf, null, req)).to.eq('DISABLED');
    expect(await featureStatusResolver(ocfCollective, null, req)).to.eq('DISABLED');

    // Check orders
    await ocfPayPalOrder.reload();
    expect(ocfPayPalOrder.data.isOCFShutdown).to.be.true;
    expect(ocfPayPalOrder.status).to.equal(OrderStatuses.PAUSED);
    await ocfStripeOrder.reload();
    expect(ocfStripeOrder.data.isOCFShutdown).to.be.true;
    expect(ocfStripeOrder.status).to.equal(OrderStatuses.PAUSED);
    await randomOrder.reload();
    expect(randomOrder.data?.messageForContributors).to.be.undefined;
    expect(randomOrder.status).to.equal(OrderStatuses.ACTIVE);

    // Run the `cron/hourly/70-handle-batch-subscriptions-update.ts` CRON job
    await handleBatchSubscriptionsUpdate();

    // Paypal order should be cancelled on the Paypal side
    expect(PayPalSubscriptionAPI.cancelPaypalSubscription['callCount']).to.equal(1);

    // Check that the message was sent to the OCF orders
    expect(emailSendMessageSpy.callCount).to.equal(2);
    expect(emailSendMessageSpy.firstCall.args[1]).to.equal(
      `Your contribution to ${ocfCollective.name} has been paused`,
    );
  });
});
