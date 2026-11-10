import { expect } from 'chai';
import gql from 'fake-tag';
import moment from 'moment';
import { createSandbox } from 'sinon';

import ActivityTypes from '../../../server/constants/activities';
import OrderStatuses from '../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import roles from '../../../server/constants/roles';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { idEncode } from '../../../server/graphql/v2/identifiers';
import {
  applyPendingTierChangeAfterCharge,
  doesAmountSatisfyTier,
  syncBackerMembershipTier,
} from '../../../server/lib/order-tier-change';
import * as paymentsLib from '../../../server/lib/payments';
import { ordersWithPendingCharges, processOrderWithSubscription } from '../../../server/lib/recurring-contributions';
import models from '../../../server/models';
import type Order from '../../../server/models/Order';
import type Tier from '../../../server/models/Tier';
import type User from '../../../server/models/User';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrder,
  fakePaymentMethod,
  fakeTier,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../utils';

const UPDATE_ORDER_MUTATION = gql`
  mutation UpdateOrder($order: OrderReferenceInput!, $amount: AmountInput, $tier: TierReferenceInput) {
    updateOrder(order: $order, amount: $amount, tier: $tier) {
      id
      amount {
        valueInCents
      }
      tier {
        legacyId
      }
      pendingTierChange {
        requestedAt
        tier {
          legacyId
        }
      }
    }
  }
`;

const ORDER_QUERY = gql`
  query Order($order: OrderReferenceInput!) {
    order(order: $order) {
      id
      pendingTierChange {
        tier {
          legacyId
        }
      }
    }
  }
`;

describe('server/lib/order-tier-change', () => {
  const sandbox = createSandbox();
  let collective, goldTier: Tier, silverTier: Tier;

  before(async () => {
    await resetTestDB();
    const host = await fakeActiveHost({ currency: 'USD' });
    collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD', isActive: true });
    goldTier = await fakeTier({
      CollectiveId: collective.id,
      name: 'Gold Sponsor',
      amountType: 'FIXED',
      amount: 100000,
      currency: 'USD',
      interval: 'month',
    });
    silverTier = await fakeTier({
      CollectiveId: collective.id,
      name: 'Silver Sponsor',
      amountType: 'FLEXIBLE',
      amount: 10000,
      minimumAmount: 10000,
      currency: 'USD',
      interval: 'month',
    });
  });

  afterEach(() => sandbox.restore());

  const recordCharge = (order: Order, amount: number) =>
    fakeTransaction({
      OrderId: order.id,
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      amount,
      currency: 'USD',
    });

  /** A monthly contribution from a new contributor, charged once at its current amount */
  const createPaidRecurringOrder = async (amount: number, tier: Tier | null = null) => {
    const user = await fakeUser();
    const paymentMethod = await fakePaymentMethod({
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
      CollectiveId: user.CollectiveId,
    });
    const order = await fakeOrder(
      {
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        PaymentMethodId: paymentMethod.id,
        TierId: tier?.id || null,
        totalAmount: amount,
        platformTipAmount: 0,
        currency: 'USD',
        interval: 'month',
        status: OrderStatuses.ACTIVE,
        subscription: {
          activatedAt: moment().subtract(1, 'month').toDate(),
          nextChargeDate: moment().add(20, 'days').toDate(),
          nextPeriodStart: moment().add(20, 'days').toDate(),
        },
      },
      { withSubscription: true, withBackerMember: true },
    );
    await recordCharge(order, amount);
    return order;
  };

  const getBackerMemberships = (order: Order) =>
    models.Member.findAll({
      where: { MemberCollectiveId: order.FromCollectiveId, CollectiveId: order.CollectiveId, role: roles.BACKER },
    });

  const updateOrder = (order: Order, variables: Record<string, unknown>, remoteUser: User = order.createdByUser) =>
    graphqlQueryV2(UPDATE_ORDER_MUTATION, { order: { id: idEncode(order.id, 'order') }, ...variables }, remoteUser);

  /** Runs the recurring contributions job for this order, with the payment provider stubbed */
  const chargeWithCron = async (order: Order, chargeResult: () => Promise<unknown>) => {
    await order.Subscription.update({ nextChargeDate: moment().subtract(1, 'day').toDate() });
    sandbox.stub(paymentsLib, 'processOrder').callsFake(chargeResult as typeof paymentsLib.processOrder);
    const { rows } = await ordersWithPendingCharges({ limitedToOrderIds: [order.id] });
    expect(rows).to.have.length(1);
    await processOrderWithSubscription(rows[0], { dryRun: false });
    await order.reload();
  };

  describe('updateOrder', () => {
    it('does not give the tier before it is paid (exploit scenario)', async () => {
      const order = await createPaidRecurringOrder(100); // $1/month, no tier
      const result = await updateOrder(order, { tier: { legacyId: goldTier.id }, amount: { valueInCents: 100000 } });

      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.amount.valueInCents).to.eq(100000); // Billed from the next charge
      expect(result.data.updateOrder.tier).to.be.null;
      expect(result.data.updateOrder.pendingTierChange.tier.legacyId).to.eq(goldTier.id);

      await order.reload();
      expect(order.TierId).to.be.null;
      expect(order.data.pendingTierChange).to.containSubset({
        TierId: goldTier.id,
        previousTierId: null,
        requestedByUserId: order.CreatedByUserId,
      });

      const memberships = await getBackerMemberships(order);
      expect(memberships).to.have.length(1);
      expect(memberships[0].TierId).to.be.null;

      // Audit trail
      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.ORDER_UPDATED, OrderId: order.id },
      });
      expect(activity).to.exist;
      expect(activity.UserId).to.eq(order.CreatedByUserId);
      expect(activity.data).to.containSubset({
        tierChange: 'PENDING',
        previousTierId: null,
        requestedTierId: goldTier.id,
        previousValues: { totalAmount: 100 },
        newValues: { totalAmount: 100000 },
      });
    });

    it('applies downgrades immediately', async () => {
      const order = await createPaidRecurringOrder(100000, goldTier);
      const result = await updateOrder(order, { tier: { legacyId: silverTier.id }, amount: { valueInCents: 10000 } });

      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.tier.legacyId).to.eq(silverTier.id);
      expect(result.data.updateOrder.pendingTierChange).to.be.null;

      const memberships = await getBackerMemberships(order);
      expect(memberships.map(m => m.TierId)).to.deep.eq([silverTier.id]);

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.ORDER_UPDATED, OrderId: order.id },
      });
      expect(activity.data).to.containSubset({ tierChange: 'APPLIED', previousTierId: goldTier.id });
    });

    it('applies moving to a custom contribution immediately', async () => {
      const order = await createPaidRecurringOrder(100000, goldTier);
      const result = await updateOrder(order, { tier: { isCustom: true }, amount: { valueInCents: 500 } });

      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.tier).to.be.null;
      const memberships = await getBackerMemberships(order);
      expect(memberships.map(m => m.TierId)).to.deep.eq([null]);
    });

    it('applies an upgrade immediately when the latest charge already paid for it', async () => {
      const order = await createPaidRecurringOrder(100000); // Already paying $1,000/month without tier
      const result = await updateOrder(order, { tier: { legacyId: goldTier.id } });

      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.tier.legacyId).to.eq(goldTier.id);
      const memberships = await getBackerMemberships(order);
      expect(memberships.map(m => m.TierId)).to.deep.eq([goldTier.id]);
    });

    it('does not count refunded charges as paid', async () => {
      const order = await createPaidRecurringOrder(100000);
      const credit = await models.Transaction.findOne({ where: { OrderId: order.id } });
      const refund = await fakeTransaction({ OrderId: order.id, isRefund: true, amount: -100000 });
      await credit.update({ RefundTransactionId: refund.id });

      const result = await updateOrder(order, { tier: { legacyId: goldTier.id } });
      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.tier).to.be.null;
      expect(result.data.updateOrder.pendingTierChange.tier.legacyId).to.eq(goldTier.id);
    });

    it('cannot chain an unpaid amount increase with a tier change', async () => {
      const order = await createPaidRecurringOrder(100);
      const result1 = await updateOrder(order, { amount: { valueInCents: 100000 } }); // No tier: applied
      expect(result1.errors).to.not.exist;
      const result2 = await updateOrder(order, { tier: { legacyId: goldTier.id } });
      expect(result2.errors).to.not.exist;
      expect(result2.data.updateOrder.tier).to.be.null;
      expect(result2.data.updateOrder.pendingTierChange.tier.legacyId).to.eq(goldTier.id);
    });

    it('drops the pending change when going back to the current tier', async () => {
      const order = await createPaidRecurringOrder(100);
      await updateOrder(order, { tier: { legacyId: goldTier.id }, amount: { valueInCents: 100000 } });
      const result = await updateOrder(order, { tier: { isCustom: true }, amount: { valueInCents: 100 } });

      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.pendingTierChange).to.be.null;
      await order.reload();
      expect(order.data.pendingTierChange).to.not.exist;
      expect(order.totalAmount).to.eq(100);

      const activities = await models.Activity.findAll({
        where: { type: ActivityTypes.ORDER_UPDATED, OrderId: order.id },
        order: [['id', 'ASC']],
      });
      expect(activities.map(a => a.data.tierChange)).to.deep.eq(['PENDING', 'PENDING_CANCELLED']);
    });

    it('replaces the pending change on repeated updates, and validates amount-only updates against it', async () => {
      const order = await createPaidRecurringOrder(100);
      await updateOrder(order, { tier: { legacyId: goldTier.id }, amount: { valueInCents: 100000 } });

      // The pending tier is fixed at $1,000: can't lower the amount without changing the tier
      const invalidResult = await updateOrder(order, { amount: { valueInCents: 100 } });
      expect(invalidResult.errors).to.exist;
      expect(invalidResult.errors[0].message).to.match(/This tier uses a fixed amount/);

      const result = await updateOrder(order, { tier: { legacyId: silverTier.id }, amount: { valueInCents: 20000 } });
      expect(result.errors).to.not.exist;
      expect(result.data.updateOrder.pendingTierChange.tier.legacyId).to.eq(silverTier.id);
      await order.reload();
      expect(order.TierId).to.be.null;
      expect(order.totalAmount).to.eq(20000);
    });

    it('only shows the pending tier change to admins', async () => {
      const order = await createPaidRecurringOrder(100);
      await updateOrder(order, { tier: { legacyId: goldTier.id }, amount: { valueInCents: 100000 } });

      const orderRef = { order: { id: idEncode(order.id, 'order') } };
      const asRandomUser = await graphqlQueryV2(ORDER_QUERY, orderRef, await fakeUser());
      expect(asRandomUser.data.order.pendingTierChange).to.be.null;
      const asContributor = await graphqlQueryV2(ORDER_QUERY, orderRef, order.createdByUser);
      expect(asContributor.data.order.pendingTierChange.tier.legacyId).to.eq(goldTier.id);
    });
  });

  describe('charges', () => {
    it('applies the pending tier once the recurring charge pays for it', async () => {
      const order = await createPaidRecurringOrder(100);
      await updateOrder(order, { tier: { legacyId: goldTier.id }, amount: { valueInCents: 100000 } });
      await order.reload();

      await chargeWithCron(order, () => recordCharge(order, 100000));

      expect(order.status).to.eq(OrderStatuses.ACTIVE);
      expect(order.TierId).to.eq(goldTier.id);
      expect(order.data.pendingTierChange).to.not.exist;
      const memberships = await getBackerMemberships(order);
      expect(memberships.map(m => m.TierId)).to.deep.eq([goldTier.id]);

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.ORDER_UPDATED, OrderId: order.id },
        order: [['id', 'DESC']],
      });
      expect(activity.data).to.containSubset({
        previousTierId: null,
        TierId: goldTier.id,
        pendingTierChange: { status: 'APPLIED', paidAmount: 100000 },
      });
    });

    it('keeps the change pending when the charge fails', async () => {
      const order = await createPaidRecurringOrder(100);
      await updateOrder(order, { tier: { legacyId: goldTier.id }, amount: { valueInCents: 100000 } });
      await order.reload();

      await chargeWithCron(order, () => Promise.reject(new Error('Your card was declined.')));

      expect(order.status).to.eq(OrderStatuses.ERROR);
      expect(order.TierId).to.be.null;
      expect(order.data.pendingTierChange.TierId).to.eq(goldTier.id);
      const memberships = await getBackerMemberships(order);
      expect(memberships.map(m => m.TierId)).to.deep.eq([null]);
    });

    it('keeps the change pending when the charge does not pay for the tier', async () => {
      const order = await createPaidRecurringOrder(100);
      await updateOrder(order, { tier: { legacyId: goldTier.id }, amount: { valueInCents: 100000 } });
      await order.reload();

      // e.g. PayPal plan out of sync with the order
      const applied = await applyPendingTierChangeAfterCharge(order, await recordCharge(order, 100));
      expect(applied).to.be.false;
      await order.reload();
      expect(order.TierId).to.be.null;
      expect(order.data.pendingTierChange.TierId).to.eq(goldTier.id);
    });

    it('discards the pending change if the tier was deleted', async () => {
      const tier = await fakeTier({ CollectiveId: collective.id, amountType: 'FIXED', amount: 50000, currency: 'USD' });
      const order = await createPaidRecurringOrder(100);
      await updateOrder(order, { tier: { legacyId: tier.id }, amount: { valueInCents: 50000 } });
      await order.reload();
      await tier.destroy();

      const applied = await applyPendingTierChangeAfterCharge(order, await recordCharge(order, 50000));
      expect(applied).to.be.false;
      await order.reload();
      expect(order.TierId).to.be.null;
      expect(order.data.pendingTierChange).to.not.exist;
    });

    it('does nothing for charges without a pending change', async () => {
      const order = await createPaidRecurringOrder(100);
      expect(await applyPendingTierChangeAfterCharge(order, await recordCharge(order, 100))).to.be.false;
    });
  });

  describe('syncBackerMembershipTier', () => {
    it('keeps the source membership when another paid contribution relies on it', async () => {
      const order = await createPaidRecurringOrder(100000, goldTier);
      // A one-time contribution on the same tier
      await fakeOrder({
        CreatedByUserId: order.CreatedByUserId,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        TierId: goldTier.id,
        totalAmount: 100000,
        status: OrderStatuses.PAID,
      });

      await syncBackerMembershipTier(order, goldTier.id, silverTier.id);
      const memberships = await getBackerMemberships(order);
      expect(memberships.map(m => m.TierId).sort()).to.deep.eq([goldTier.id, silverTier.id].sort());
    });

    it('removes the source membership when the target one already exists', async () => {
      const order = await createPaidRecurringOrder(100000, goldTier);
      await models.Member.create({
        MemberCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        role: roles.BACKER,
        TierId: null,
        CreatedByUserId: order.CreatedByUserId,
      });

      await syncBackerMembershipTier(order, goldTier.id, null);
      const memberships = await getBackerMemberships(order);
      expect(memberships.map(m => m.TierId)).to.deep.eq([null]);
    });
  });

  describe('doesAmountSatisfyTier', () => {
    const order = { currency: 'USD', quantity: 1, data: {} } as Order;

    it('accepts tiers without a price', () => {
      expect(doesAmountSatisfyTier(null, order, null)).to.be.true;
      expect(
        doesAmountSatisfyTier(
          { amountType: 'FLEXIBLE', amount: null, minimumAmount: null, currency: 'USD' },
          order,
          null,
        ),
      ).to.be.true;
    });

    it('requires a payment of at least the fixed price or minimum', () => {
      const fixed = { amountType: 'FIXED' as const, amount: 1000, minimumAmount: null, currency: 'USD' as const };
      expect(doesAmountSatisfyTier(fixed, order, null)).to.be.false;
      expect(doesAmountSatisfyTier(fixed, order, 999)).to.be.false;
      expect(doesAmountSatisfyTier(fixed, order, 1000)).to.be.true;
      expect(doesAmountSatisfyTier(fixed, order, 5000)).to.be.true;
      expect(doesAmountSatisfyTier(fixed, { ...order, quantity: 2 } as Order, 1000)).to.be.false;

      const flexible = { amountType: 'FLEXIBLE' as const, amount: 5000, minimumAmount: 1000, currency: 'USD' as const };
      expect(doesAmountSatisfyTier(flexible, order, 999)).to.be.false;
      expect(doesAmountSatisfyTier(flexible, order, 1000)).to.be.true;
    });

    it('rejects priced tiers in another currency', () => {
      const eurTier = { amountType: 'FIXED' as const, amount: 1000, minimumAmount: null, currency: 'EUR' as const };
      expect(doesAmountSatisfyTier(eurTier, order, 5000)).to.be.false;
      const freeEurTier = {
        amountType: 'FLEXIBLE' as const,
        amount: null,
        minimumAmount: null,
        currency: 'EUR' as const,
      };
      expect(doesAmountSatisfyTier(freeEurTier, order, null)).to.be.true;
    });

    it('compares the pre-tax amount', () => {
      const fixed = { amountType: 'FIXED' as const, amount: 1000, minimumAmount: null, currency: 'USD' as const };
      const taxedOrder = { ...order, data: { tax: { id: 'VAT', percentage: 20 } } } as Order;
      expect(doesAmountSatisfyTier(fixed, taxedOrder, 1100)).to.be.false;
      expect(doesAmountSatisfyTier(fixed, taxedOrder, 1200)).to.be.true;
    });
  });
});
