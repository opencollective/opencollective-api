/**
 * Regression tests for https://github.com/opencollective/opencollective/issues/8915 and
 * https://github.com/opencollective/opencollective/issues/7701
 *
 * Bulk cancellations (`deleteTier(stopRecurringContributions: true)`, archiving an account) used to mark orders
 * `CANCELLED` without deactivating their `Subscription`. `ordersWithPendingCharges` did not exclude `CANCELLED`, so
 * the next billing cycle charged the saved payment method and flipped the order back to `ACTIVE`: cancel -> charge
 * -> un-cancel, forever.
 */

import { expect } from 'chai';
import gql from 'fake-tag';
import { assert as sinonAssert, createSandbox } from 'sinon';

import { run as runChargeRecurringContributions } from '../../../cron/hourly/00-charge-recurring-contributions';
import OrderStatuses from '../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import { ordersWithPendingCharges } from '../../../server/lib/recurring-contributions';
import * as SentryLib from '../../../server/lib/sentry';
import models from '../../../server/models';
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTier,
  fakeUser,
} from '../../test-helpers/fake-data';
import { graphqlQuery, graphqlQueryV2, resetTestDB } from '../../utils';

const DELETE_TIER_MUTATION = gql`
  mutation DeleteTier($tier: TierReferenceInput!, $stopRecurringContributions: Boolean) {
    deleteTier(tier: $tier, stopRecurringContributions: $stopRecurringContributions) {
      id
    }
  }
`;

// Not wrapped in `gql` on purpose: the ESLint GraphQL processor would validate it against the V2 schema, but
// `archiveCollective` only exists in V1.
const ARCHIVE_COLLECTIVE_MUTATION = `
  mutation ArchiveCollective($id: Int!) {
    archiveCollective(id: $id) {
      id
      isArchived
    }
  }
`;

const CHARGE_CRON_OPTIONS = { dryRun: true, limit: 500, concurrency: 3, simulate: false, orderIds: undefined };

describe('cron/hourly/00-charge-recurring-contributions (regression #8915, #7701)', () => {
  let sandbox, host;

  beforeEach(async () => {
    await resetTestDB();
    host = await fakeHost();
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** A due recurring contribution that `ordersWithPendingCharges` would happily charge on its next run */
  const fakeDueRecurringOrder = async (orderData = {}) => {
    const paymentMethod = await fakePaymentMethod({
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
    });

    return fakeOrder(
      {
        status: OrderStatuses.ACTIVE,
        PaymentMethodId: paymentMethod.id,
        ...orderData,
        subscription: {
          isActive: true,
          activatedAt: new Date('2020-01-01'),
          nextChargeDate: new Date('2020-01-01'),
        },
      },
      { withSubscription: true, withTransactions: true },
    );
  };

  it('does not charge contributions cancelled by a tier deletion', async () => {
    const sentryStub = sandbox.stub(SentryLib, 'reportErrorToSentry');
    const admin = await fakeUser();
    const collective = await fakeCollective({ HostCollectiveId: host.id, admin });
    const tier = await fakeTier({ CollectiveId: collective.id });
    const order = await fakeDueRecurringOrder({ CollectiveId: collective.id, TierId: tier.id });
    const transactionCountBefore = await models.Transaction.count({ where: { OrderId: order.id } });

    // Sanity check: the contribution is due and would be charged on the next billing run
    expect((await ordersWithPendingCharges()).rows.map(o => o.id)).to.include(order.id);

    const result = await graphqlQueryV2(
      DELETE_TIER_MUTATION,
      { tier: { legacyId: tier.id }, stopRecurringContributions: true },
      admin,
    );
    expect(result.errors).to.not.exist;

    // The order is cancelled and flagged for asynchronous deactivation right away
    await order.reload();
    expect(order.status).to.equal(OrderStatuses.CANCELLED);
    expect(order.data.needsAsyncDeactivation).to.be.true;

    // It is no longer selected for charges, even though its subscription is still active: deactivating it (and
    // cancelling it on the payment provider side) is the job of `cron/10mn/00-handle-batch-subscriptions-update`
    await order.Subscription.reload();
    expect(order.Subscription.isActive).to.be.true;
    expect((await ordersWithPendingCharges()).rows.map(o => o.id)).to.not.include(order.id);

    await runChargeRecurringContributions(CHARGE_CRON_OPTIONS);

    await order.reload();
    expect(order.status).to.equal(OrderStatuses.CANCELLED);
    expect(await models.Transaction.count({ where: { OrderId: order.id } })).to.equal(transactionCountBefore);

    // Waiting for the 10-minute deactivation job is a normal transient state, not something to alert on
    sinonAssert.notCalled(sentryStub);
  });

  it('does not charge contributions made by an archived account', async () => {
    const sentryStub = sandbox.stub(SentryLib, 'reportErrorToSentry');
    const admin = await fakeUser();
    const archivedAccount = await fakeCollective({ admin });
    const recipient = await fakeCollective({ HostCollectiveId: host.id });
    const order = await fakeDueRecurringOrder({ CollectiveId: recipient.id, FromCollectiveId: archivedAccount.id });
    const transactionCountBefore = await models.Transaction.count({ where: { OrderId: order.id } });

    expect((await ordersWithPendingCharges()).rows.map(o => o.id)).to.include(order.id);

    const result = await graphqlQuery(ARCHIVE_COLLECTIVE_MUTATION, { id: archivedAccount.id }, admin);
    expect(result.errors).to.not.exist;

    await order.reload();
    expect(order.status).to.equal(OrderStatuses.CANCELLED);
    expect(order.data.needsAsyncDeactivation).to.be.true;
    expect((await ordersWithPendingCharges()).rows.map(o => o.id)).to.not.include(order.id);

    await runChargeRecurringContributions(CHARGE_CRON_OPTIONS);

    await order.reload();
    expect(order.status).to.equal(OrderStatuses.CANCELLED);
    expect(await models.Transaction.count({ where: { OrderId: order.id } })).to.equal(transactionCountBefore);

    // Waiting for the 10-minute deactivation job is a normal transient state, not something to alert on
    sinonAssert.notCalled(sentryStub);
  });

  it('reports cancelled contributions that still have an active subscription, without charging them', async () => {
    const sentryStub = sandbox.stub(SentryLib, 'reportErrorToSentry');
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    // The inconsistent state left behind by the pre-fix bulk cancellations
    const brokenOrder = await fakeDueRecurringOrder({ CollectiveId: collective.id, status: OrderStatuses.CANCELLED });
    const transactionCountBefore = await models.Transaction.count({ where: { OrderId: brokenOrder.id } });

    await runChargeRecurringContributions(CHARGE_CRON_OPTIONS);

    // Never charged...
    await brokenOrder.reload();
    expect(brokenOrder.status).to.equal(OrderStatuses.CANCELLED);
    expect(await models.Transaction.count({ where: { OrderId: brokenOrder.id } })).to.equal(transactionCountBefore);
    expect((await ordersWithPendingCharges()).rows.map(o => o.id)).to.not.include(brokenOrder.id);

    // ...but someone hears about it
    sinonAssert.called(sentryStub);
    const reported = sentryStub.getCalls().map(call => call.args[0]?.message);
    expect(reported).to.include('1 cancelled recurring contribution(s) still have an active subscription');
  });
});
