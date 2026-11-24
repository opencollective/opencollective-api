import { expect } from 'chai';
import config from 'config';
import { createSandbox, SinonStub } from 'sinon';

import { CANCELLATION_REASON, disconnectPaypalHost } from '../../../scripts/paypal/disconnect-host';
import ActivityTypes from '../../../server/constants/activities';
import OrderStatuses from '../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import emailLib from '../../../server/lib/email';
import { findCancelledOrdersWithActiveSubscriptions } from '../../../server/lib/recurring-contributions';
import models, { Collective } from '../../../server/models';
import * as PaypalAPI from '../../../server/paymentProviders/paypal/api';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
  randStr,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

/** Creates an order with an active PayPal subscription. Charged under `chargedByHost` if provided. */
const fakePaypalSubscriptionOrder = async (
  collective: Collective,
  {
    status = OrderStatuses.ACTIVE,
    data = {},
    chargedByHost = undefined,
  }: { status?: OrderStatuses; data?: Record<string, unknown>; chargedByHost?: Collective } = {},
) => {
  const paypalSubscriptionId = randStr('I-');
  const paymentMethod = await fakePaymentMethod({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    token: paypalSubscriptionId,
  });

  const order = await fakeOrder(
    {
      CollectiveId: collective.id,
      PaymentMethodId: paymentMethod.id,
      interval: 'month',
      status,
      data,
      subscription: { paypalSubscriptionId, isActive: true, isManagedExternally: true },
    },
    { withSubscription: true },
  );

  if (chargedByHost) {
    await fakeTransaction({
      OrderId: order.id,
      CollectiveId: collective.id,
      FromCollectiveId: order.FromCollectiveId,
      HostCollectiveId: chargedByHost.id,
      kind: TransactionKind.CONTRIBUTION,
      type: 'CREDIT',
      amount: 1000,
    });
  }

  return order;
};

const fakeHostWithPaypal = async () => {
  const host = await fakeHost();
  const connectedAccount = await fakeConnectedAccount({
    CollectiveId: host.id,
    service: 'paypal',
    clientId: randStr(),
    token: randStr(),
    settings: { webhookId: 'WH-OC' },
  });
  return { host, connectedAccount };
};

/**
 * Mocks the PayPal API. `subscriptionStatuses` maps PayPal subscription IDs to their status (or an Error to throw).
 */
const stubPaypal = (
  stub: SinonStub,
  subscriptionStatuses: Record<string, string | Error>,
  webhooks = [
    { id: 'WH-OC', url: `${config.host.api}/webhooks/paypal/1` },
    { id: 'WH-OTHER', url: 'https://example.com/webhooks' },
  ],
) => {
  stub.callsFake(async (url: string, _body, _host, method: string) => {
    const match = url.match(/^billing\/subscriptions\/([^/]+)(\/cancel)?$/);
    if (match) {
      const status = subscriptionStatuses[match[1]];
      if (status instanceof Error) {
        throw status;
      } else if (method === 'GET') {
        return { id: match[1], status };
      } else {
        return null; // Cancel
      }
    } else if (url === 'notifications/webhooks' && method === 'GET') {
      return { webhooks };
    } else if (url.startsWith('notifications/webhooks/') && method === 'DELETE') {
      return null;
    }

    throw new Error(`Unexpected PayPal request: ${method} ${url}`);
  });
};

const getCalls = (stub: SinonStub, method: string) =>
  stub
    .getCalls()
    .filter(call => (call.args[3] || 'POST') === method)
    .map(call => call.args[0]);

describe('scripts/paypal/disconnect-host', () => {
  let sandbox, paypalRequestStub: SinonStub, sendEmailSpy;

  beforeEach(async () => {
    await resetTestDB();
    sandbox = createSandbox();
    paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  afterEach(() => {
    sandbox.restore();
  });

  const runAndCountEmails = async (...args: Parameters<typeof disconnectPaypalHost>) => {
    await models.Activity.waitAllDispatch();
    sendEmailSpy.resetHistory();
    const report = await disconnectPaypalHost(...args);
    await models.Activity.waitAllDispatch();
    return { report, sentEmails: sendEmailSpy.callCount };
  };

  it('cancels the subscriptions on PayPal and disconnects a connected host', async () => {
    const { host, connectedAccount } = await fakeHostWithPaypal();
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const activeOrder = await fakePaypalSubscriptionOrder(collective, { chargedByHost: host });
    const suspendedOrder = await fakePaypalSubscriptionOrder(collective, { chargedByHost: host });
    const alreadyCancelledOrder = await fakePaypalSubscriptionOrder(collective, { chargedByHost: host });
    const notFoundOrder = await fakePaypalSubscriptionOrder(collective, { chargedByHost: host });
    const subId = order => order.Subscription.paypalSubscriptionId;
    stubPaypal(paypalRequestStub, {
      [subId(activeOrder)]: 'ACTIVE',
      [subId(suspendedOrder)]: 'SUSPENDED',
      [subId(alreadyCancelledOrder)]: 'CANCELLED',
      [subId(notFoundOrder)]: new Error('PayPal request failed (404): RESOURCE_NOT_FOUND'),
    });

    const { report, sentEmails } = await runAndCountEmails({ hostSlug: host.slug, execute: true, throttleMs: 0 });

    expect(sentEmails).to.eq(0);
    expect(report.isConnected).to.be.true;
    expect(report.cancelledOnPaypal).to.deep.eqInAnyOrder([activeOrder.id, suspendedOrder.id]);
    expect(report.alreadyCancelled).to.deep.eq([alreadyCancelledOrder.id]);
    expect(report.manualReview).to.deep.eq([notFoundOrder.id]);
    expect(report.cancelledInDb).to.have.length(4);

    // PayPal calls
    expect(getCalls(paypalRequestStub, 'POST')).to.deep.eqInAnyOrder([
      `billing/subscriptions/${subId(activeOrder)}/cancel`,
      `billing/subscriptions/${subId(suspendedOrder)}/cancel`,
    ]);
    const cancelCall = paypalRequestStub.getCalls().find(call => call.args[0].endsWith('/cancel'));
    expect(cancelCall.args[1]).to.deep.eq({ reason: CANCELLATION_REASON });
    expect(cancelCall.args[2].id).to.eq(host.id);
    expect(getCalls(paypalRequestStub, 'DELETE')).to.deep.eq(['notifications/webhooks/WH-OC']);
    expect(report.deletedWebhookIds).to.deep.eq(['WH-OC']);

    // Connected account is soft-deleted
    expect(await models.ConnectedAccount.findByPk(connectedAccount.id)).to.be.null;
    const deletedAccount = await models.ConnectedAccount.findByPk(connectedAccount.id, { paranoid: false });
    expect(deletedAccount.deletedAt).to.exist;

    // DB
    for (const order of [activeOrder, suspendedOrder, alreadyCancelledOrder, notFoundOrder]) {
      await order.reload();
      await order.Subscription.reload();
      expect(order.status).to.eq(OrderStatuses.CANCELLED);
      expect(order.Subscription.isActive).to.be.false;
      expect(order.Subscription.deactivatedAt).to.exist;
      expect(order.data.paypalHostDisconnection.HostCollectiveId).to.eq(host.id);
      expect(order.data.paypalHostDisconnection.previousStatus).to.eq(OrderStatuses.ACTIVE);
    }

    expect(activeOrder.data.paypalHostDisconnection.paypalOutcome).to.eq('cancelledOnPaypal');
    expect(alreadyCancelledOrder.data.paypalHostDisconnection.paypalOutcome).to.eq('alreadyCancelled');
    expect(notFoundOrder.data.paypalHostDisconnection.paypalOutcome).to.eq('manualReview');
    expect(notFoundOrder.data.paypalHostDisconnection.error).to.include('RESOURCE_NOT_FOUND');

    // Silent activities
    const activities = await models.Activity.findAll({ where: { type: ActivityTypes.SUBSCRIPTION_CANCELED } });
    expect(activities).to.have.length(4);
    activities.forEach(activity => expect(activity.data.notify).to.be.false);

    expect((await findCancelledOrdersWithActiveSubscriptions()).count).to.eq(0);
  });

  it('only cancels in the database for a host without PayPal connection', async () => {
    const host = await fakeHost();
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const order = await fakePaypalSubscriptionOrder(collective, { chargedByHost: host });

    const { report, sentEmails } = await runAndCountEmails({ hostSlug: host.slug, execute: true, throttleMs: 0 });

    expect(sentEmails).to.eq(0);
    expect(paypalRequestStub.called).to.be.false;
    expect(report.isConnected).to.be.false;
    expect(report.hostNotConnected).to.deep.eq([order.id]);
    expect(report.cancelledInDb).to.deep.eq([order.id]);

    await order.reload();
    await order.Subscription.reload();
    expect(order.status).to.eq(OrderStatuses.CANCELLED);
    expect(order.Subscription.isActive).to.be.false;
    expect(order.data.paypalHostDisconnection.paypalOutcome).to.eq('hostNotConnected');
  });

  it('cleans up already CANCELLED orders with stale async flags, without a new activity', async () => {
    const host = await fakeHost();
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const order = await fakePaypalSubscriptionOrder(collective, {
      status: OrderStatuses.CANCELLED,
      chargedByHost: host,
      data: {
        needsAsyncDeactivation: true,
        needsAsyncPause: true,
        needsAsyncReactivation: true,
        customData: { foo: 'bar' },
      },
    });

    const { sentEmails } = await runAndCountEmails({ hostSlug: host.slug, execute: true, throttleMs: 0 });
    expect(sentEmails).to.eq(0);

    await order.reload();
    await order.Subscription.reload();
    expect(order.status).to.eq(OrderStatuses.CANCELLED);
    expect(order.Subscription.isActive).to.be.false;
    expect(order.data.needsAsyncDeactivation).to.be.undefined;
    expect(order.data.needsAsyncPause).to.be.undefined;
    expect(order.data.needsAsyncReactivation).to.be.undefined;
    expect(order.data.customData).to.deep.eq({ foo: 'bar' });
    expect(order.data.paypalHostDisconnection.previousStatus).to.eq(OrderStatuses.CANCELLED);
    expect(await models.Activity.count({ where: { OrderId: order.id } })).to.eq(0);

    // Idempotent
    const { report } = await runAndCountEmails({ hostSlug: host.slug, execute: true, throttleMs: 0 });
    expect(report.cancelledInDb).to.be.empty;
  });

  it('uses the host of the last charge for collectives that moved', async () => {
    const { host: oldHost } = await fakeHostWithPaypal();
    const { host: newHost } = await fakeHostWithPaypal();

    // Charged by the old host, collective moved to the new host since then
    const movedCollective = await fakeCollective({ HostCollectiveId: newHost.id });
    const movedOrder = await fakePaypalSubscriptionOrder(movedCollective, { chargedByHost: oldHost });

    // Migrated collective: first charged by the old host, now charged by the new host
    const migratedCollective = await fakeCollective({ HostCollectiveId: newHost.id });
    const migratedOrder = await fakePaypalSubscriptionOrder(migratedCollective, { chargedByHost: oldHost });
    await fakeTransaction({
      OrderId: migratedOrder.id,
      CollectiveId: migratedCollective.id,
      HostCollectiveId: newHost.id,
      kind: TransactionKind.CONTRIBUTION,
      type: 'CREDIT',
      amount: 1000,
      createdAt: new Date(Date.now() + 1000),
    });

    // Never charged, still hosted by the old host
    const oldHostCollective = await fakeCollective({ HostCollectiveId: oldHost.id });
    const pendingOrder = await fakePaypalSubscriptionOrder(oldHostCollective);

    // Archived collective (no host anymore), charged by the old host
    const archivedCollective = await fakeCollective({ HostCollectiveId: oldHost.id });
    const archivedOrder = await fakePaypalSubscriptionOrder(archivedCollective, { chargedByHost: oldHost });
    await archivedCollective.update({ HostCollectiveId: null, isActive: false, approvedAt: null });

    stubPaypal(paypalRequestStub, {
      [movedOrder.Subscription.paypalSubscriptionId]: 'ACTIVE',
      [pendingOrder.Subscription.paypalSubscriptionId]: 'ACTIVE',
      [archivedOrder.Subscription.paypalSubscriptionId]: 'ACTIVE',
    });

    const { report } = await runAndCountEmails({ hostSlug: oldHost.slug, execute: true, throttleMs: 0 });
    expect(report.cancelledInDb).to.deep.eqInAnyOrder([movedOrder.id, pendingOrder.id, archivedOrder.id]);
    paypalRequestStub.getCalls().forEach(call => expect(call.args[2].id).to.eq(oldHost.id));

    // Subscriptions charged under another, connected host are untouched
    await migratedOrder.reload();
    await migratedOrder.Subscription.reload();
    expect(migratedOrder.status).to.eq(OrderStatuses.ACTIVE);
    expect(migratedOrder.Subscription.isActive).to.be.true;
  });

  it('only processes the given orders and keeps the connection with --orders', async () => {
    const { host, connectedAccount } = await fakeHostWithPaypal();
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const targetOrder = await fakePaypalSubscriptionOrder(collective, { chargedByHost: host });
    const otherOrder = await fakePaypalSubscriptionOrder(collective, { chargedByHost: host });
    stubPaypal(paypalRequestStub, { [targetOrder.Subscription.paypalSubscriptionId]: 'ACTIVE' });

    const { report } = await runAndCountEmails({
      hostSlug: host.slug,
      execute: true,
      orderIds: [targetOrder.id],
      throttleMs: 0,
    });

    expect(report.cancelledOnPaypal).to.deep.eq([targetOrder.id]);
    expect(report.deletedWebhookIds).to.be.empty;
    expect(report.deletedConnectedAccountIds).to.be.empty;
    expect(getCalls(paypalRequestStub, 'DELETE')).to.be.empty;
    expect(await models.ConnectedAccount.findByPk(connectedAccount.id)).to.exist;

    await targetOrder.reload();
    expect(targetOrder.status).to.eq(OrderStatuses.CANCELLED);
    await otherOrder.reload();
    await otherOrder.Subscription.reload();
    expect(otherOrder.status).to.eq(OrderStatuses.ACTIVE);
    expect(otherOrder.Subscription.isActive).to.be.true;
  });

  it('writes nothing in dry run', async () => {
    const { host, connectedAccount } = await fakeHostWithPaypal();
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const order = await fakePaypalSubscriptionOrder(collective, {
      status: OrderStatuses.CANCELLED,
      chargedByHost: host,
      data: { needsAsyncDeactivation: true },
    });
    stubPaypal(paypalRequestStub, { [order.Subscription.paypalSubscriptionId]: 'ACTIVE' });

    const { report, sentEmails } = await runAndCountEmails({ hostSlug: host.slug, throttleMs: 0 });

    expect(sentEmails).to.eq(0);
    expect(report.dryRun).to.be.true;
    expect(report.cancelledOnPaypal).to.deep.eq([order.id]);
    expect(report.deletedWebhookIds).to.deep.eq(['WH-OC']);
    expect(report.deletedConnectedAccountIds).to.deep.eq([connectedAccount.id]);

    // Only read-only requests sent to PayPal
    paypalRequestStub.getCalls().forEach(call => expect(call.args[3]).to.eq('GET'));
    expect(await models.ConnectedAccount.findByPk(connectedAccount.id)).to.exist;
    await order.reload();
    await order.Subscription.reload();
    expect(order.data.needsAsyncDeactivation).to.be.true;
    expect(order.data.paypalHostDisconnection).to.be.undefined;
    expect(order.Subscription.isActive).to.be.true;
    expect(await models.Activity.count({ where: { OrderId: order.id } })).to.eq(0);
  });
});
