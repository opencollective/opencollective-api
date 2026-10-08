/* eslint-disable camelcase */

import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { run } from '../../../cron/weekly/reconcile-stale-paypal-subscriptions';
import ActivityTypes from '../../../server/constants/activities';
import OrderStatuses from '../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import emailLib from '../../../server/lib/email';
import models from '../../../server/models';
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

describe('cron/weekly/reconcile-stale-paypal-subscriptions', () => {
  let sandbox;
  let paypalRequestStub;
  let sendEmailSpy;

  before(async () => {
    await resetTestDB();
  });

  beforeEach(() => {
    sandbox = createSandbox();
    paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** Creates an active contribution managed by PayPal, with a `nextChargeDate` that's overdue by default */
  const createStaleContribution = async ({
    nextChargeDate = moment().subtract(1, 'month').toDate(),
    orderStatus = OrderStatuses.ACTIVE,
    subscriptionParams = {},
  }: { nextChargeDate?: Date; orderStatus?: OrderStatuses; subscriptionParams?: Record<string, unknown> } = {}) => {
    const host = await fakeHost();
    await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'test-paypal-token' });
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const paymentMethod = await fakePaymentMethod({
      service: PAYMENT_METHOD_SERVICE.PAYPAL,
      type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
      token: randStr(),
    });
    const order = await fakeOrder(
      {
        CollectiveId: collective.id,
        PaymentMethodId: paymentMethod.id,
        status: orderStatus,
        subscription: {
          isManagedExternally: true,
          isActive: true,
          nextChargeDate,
          ...subscriptionParams,
        },
      },
      { withSubscription: true },
    );

    return { host, collective, order, paymentMethod };
  };

  /** Waits for pending activity dispatches (from the fixtures) and only counts the ones from the cron */
  const runAndIsolateEmails = async (...args: Parameters<typeof run>) => {
    await models.Activity.waitAllDispatch();
    sendEmailSpy.resetHistory();
    await run(...args);
    await models.Activity.waitAllDispatch();
    return sendEmailSpy.callCount;
  };

  it('marks the contribution as cancelled and records a silent activity when PayPal cancelled it recently', async () => {
    const { host, order } = await createStaleContribution();
    const statusUpdateTime = moment().subtract(2, 'days');
    paypalRequestStub.resolves({
      id: order.Subscription.paypalSubscriptionId,
      status: 'CANCELLED',
      status_update_time: statusUpdateTime.toISOString(),
    });

    const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id] });
    expect(sentEmails).to.eq(0);

    await order.reload();
    expect(order.status).to.eq('CANCELLED');
    expect(order.data.previousStatus).to.eq('ACTIVE');
    expect(order.data.cancelledFromPayPalReconciliation).to.be.true;

    const subscription = await models.Subscription.findByPk(order.Subscription.id);
    expect(subscription.isActive).to.be.false;
    expect(subscription.nextChargeDate).to.be.null;
    expect(subscription.deactivatedAt.getTime()).to.be.closeTo(statusUpdateTime.valueOf(), 10000);
    expect(subscription.data.deactivatedFromPayPalReconciliation).to.be.true;

    const activity = await models.Activity.findOne({
      where: { type: ActivityTypes.SUBSCRIPTION_CANCELED, OrderId: order.id },
    });
    expect(activity).to.exist;
    expect(activity.data.notify).to.be.false;
    expect(activity.HostCollectiveId).to.eq(host.id);
    expect(activity.data.previousStatus).to.eq('ACTIVE');
  });

  it('marks the contribution as cancelled without any activity when the cancellation is old', async () => {
    const { order } = await createStaleContribution();
    paypalRequestStub.resolves({
      id: order.Subscription.paypalSubscriptionId,
      status: 'CANCELLED',
      status_update_time: moment().subtract(2, 'months').toISOString(),
    });

    const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id] });
    expect(sentEmails).to.eq(0);

    await order.reload();
    expect(order.status).to.eq('CANCELLED');
    expect(order.data.cancelledFromPayPalReconciliation).to.be.true;

    const subscription = await models.Subscription.findByPk(order.Subscription.id);
    expect(subscription.isActive).to.be.false;
    expect(subscription.nextChargeDate).to.be.null;

    expect(await models.Activity.count({ where: { OrderId: order.id } })).to.eq(0);
  });

  it('treats an EXPIRED subscription as cancelled', async () => {
    const { order } = await createStaleContribution();
    paypalRequestStub.resolves({
      id: order.Subscription.paypalSubscriptionId,
      status: 'EXPIRED',
      status_update_time: moment().subtract(1, 'day').toISOString(),
    });

    const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id] });
    expect(sentEmails).to.eq(0);

    await order.reload();
    expect(order.status).to.eq('CANCELLED');

    const subscription = await models.Subscription.findByPk(order.Subscription.id);
    expect(subscription.isActive).to.be.false;
    expect(subscription.nextChargeDate).to.be.null;
  });

  it('leaves the contribution untouched when the subscription is still active on PayPal', async () => {
    const nextChargeDate = moment().subtract(1, 'month').toDate();
    const { order } = await createStaleContribution({ nextChargeDate });
    paypalRequestStub.resolves({
      id: order.Subscription.paypalSubscriptionId,
      status: 'ACTIVE',
      status_update_time: moment().subtract(1, 'month').toISOString(),
      billing_info: { next_billing_time: moment().add(1, 'month').toISOString(), failed_payments_count: 0 },
    });

    const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id] });
    expect(sentEmails).to.eq(0);

    await order.reload();
    expect(order.status).to.eq('ACTIVE');
    expect(order.data.cancelledFromPayPalReconciliation).to.not.exist;

    const subscription = await models.Subscription.findByPk(order.Subscription.id);
    expect(subscription.isActive).to.be.true;
    expect(subscription.nextChargeDate.getTime()).to.eq(nextChargeDate.getTime());
    expect(await models.Activity.count({ where: { OrderId: order.id } })).to.eq(0);
  });

  it('leaves the contribution untouched when the subscription is suspended on PayPal', async () => {
    const { order } = await createStaleContribution();
    paypalRequestStub.resolves({
      id: order.Subscription.paypalSubscriptionId,
      status: 'SUSPENDED',
      status_update_time: moment().subtract(1, 'month').toISOString(),
    });

    const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id] });
    expect(sentEmails).to.eq(0);

    await order.reload();
    expect(order.status).to.eq('ACTIVE');

    const subscription = await models.Subscription.findByPk(order.Subscription.id);
    expect(subscription.isActive).to.be.true;
    expect(await models.Activity.count({ where: { OrderId: order.id } })).to.eq(0);
  });

  it('skips contributions whose payment method points to another PayPal subscription', async () => {
    const { order, paymentMethod } = await createStaleContribution();
    await paymentMethod.update({ token: randStr() }); // The subscription was replaced (edited contribution)

    const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id] });
    expect(sentEmails).to.eq(0);
    expect(paypalRequestStub.called).to.be.false;

    await order.reload();
    expect(order.status).to.eq('ACTIVE');
    expect(await models.Activity.count({ where: { OrderId: order.id } })).to.eq(0);
  });

  it('does not write anything in dry-run mode', async () => {
    const nextChargeDate = moment().subtract(1, 'month').toDate();
    const { order } = await createStaleContribution({ nextChargeDate });
    paypalRequestStub.resolves({
      id: order.Subscription.paypalSubscriptionId,
      status: 'CANCELLED',
      status_update_time: moment().subtract(1, 'day').toISOString(),
    });

    const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id], dryRun: true });
    expect(sentEmails).to.eq(0);
    expect(paypalRequestStub.called).to.be.true; // The status is still checked

    await order.reload();
    expect(order.status).to.eq('ACTIVE');
    expect(order.data.cancelledFromPayPalReconciliation).to.not.exist;

    const subscription = await models.Subscription.findByPk(order.Subscription.id);
    expect(subscription.isActive).to.be.true;
    expect(subscription.nextChargeDate.getTime()).to.eq(nextChargeDate.getTime());
    expect(await models.Activity.count({ where: { OrderId: order.id } })).to.eq(0);
  });

  it('does not query PayPal for contributions that are not stale', async () => {
    const { order } = await createStaleContribution({ nextChargeDate: moment().add(1, 'month').toDate() });

    const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id] });
    expect(sentEmails).to.eq(0);
    expect(paypalRequestStub.called).to.be.false;

    await order.reload();
    expect(order.status).to.eq('ACTIVE');
  });

  it('does not run when CRON_DISABLE_RECONCILE_STATE_PAYPAL_SUBSCRIPTIONS is set', async () => {
    const { order } = await createStaleContribution();
    paypalRequestStub.resolves({
      id: order.Subscription.paypalSubscriptionId,
      status: 'CANCELLED',
      status_update_time: moment().subtract(1, 'day').toISOString(),
    });

    process.env.CRON_DISABLE_RECONCILE_STATE_PAYPAL_SUBSCRIPTIONS = 'true';
    try {
      const sentEmails = await runAndIsolateEmails({ limitedToOrderIds: [order.id] });
      expect(sentEmails).to.eq(0);
    } finally {
      delete process.env.CRON_DISABLE_RECONCILE_STATE_PAYPAL_SUBSCRIPTIONS;
    }

    expect(paypalRequestStub.called).to.be.false;

    await order.reload();
    expect(order.status).to.eq('ACTIVE');
    expect(await models.Activity.count({ where: { OrderId: order.id } })).to.eq(0);
  });
});
