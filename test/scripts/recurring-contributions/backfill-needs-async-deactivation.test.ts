import { expect } from 'chai';

import {
  findOrdersToFlag,
  flagOrdersForAsyncDeactivation,
} from '../../../scripts/recurring-contributions/backfill-needs-async-deactivation';
import OrderStatuses from '../../../server/constants/order-status';
import { sequelize } from '../../../server/models';
import { fakeCollective, fakeHost, fakeOrder, fakeTier } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/recurring-contributions/backfill-needs-async-deactivation', () => {
  beforeEach(resetTestDB);

  /** A cancelled contribution whose subscription was never deactivated (the pre-#8915 state) */
  const fakeBrokenCancellation = (orderData = {}) =>
    fakeOrder({ status: OrderStatuses.CANCELLED, ...orderData }, { withSubscription: true });

  describe('findOrdersToFlag', () => {
    it('only returns cancelled orders whose subscription is still active and not yet flagged', async () => {
      const collective = await fakeCollective();
      const brokenOrder = await fakeBrokenCancellation({ CollectiveId: collective.id });
      const alreadyFlaggedOrder = await fakeOrder(
        {
          CollectiveId: collective.id,
          status: OrderStatuses.CANCELLED,
          data: { needsAsyncDeactivation: true },
        },
        { withSubscription: true },
      );
      const properlyCancelledOrder = await fakeOrder(
        {
          CollectiveId: collective.id,
          status: OrderStatuses.CANCELLED,
          subscription: { isActive: false, deactivatedAt: new Date() },
        },
        { withSubscription: true },
      );
      const activeOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );

      const orders = await findOrdersToFlag();

      expect(orders.map(order => order.id)).to.deep.equal([brokenOrder.id]);
      expect(orders.map(order => order.id)).to.not.include(alreadyFlaggedOrder.id);
      expect(orders.map(order => order.id)).to.not.include(properlyCancelledOrder.id);
      expect(orders.map(order => order.id)).to.not.include(activeOrder.id);
    });

    it('returns the orders that were charged again after an archive or a tier deletion', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const archivedAccount = await fakeCollective({ deactivatedAt: new Date() });
      const deletedTier = await fakeTier({ CollectiveId: collective.id });

      const chargedAfterArchive = await fakeOrder(
        { CollectiveId: collective.id, FromCollectiveId: archivedAccount.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );

      // Cancelled by the tier deletion, then flipped back to ACTIVE by a successful charge (kept in the history)
      const chargedAfterTierDeletion = await fakeOrder(
        { CollectiveId: collective.id, TierId: deletedTier.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      await chargedAfterTierDeletion.update({ status: OrderStatuses.CANCELLED });
      await chargedAfterTierDeletion.update({ status: OrderStatuses.ACTIVE });

      // Tier deleted without `stopRecurringContributions`: the contribution legitimately stays active
      const keptOnDeletedTier = await fakeOrder(
        { CollectiveId: collective.id, TierId: deletedTier.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      await deletedTier.destroy();

      const orders = await findOrdersToFlag();

      expect(orders.map(order => [order.id, order.reason])).to.have.deep.members([
        [chargedAfterArchive.id, 'CHARGED_AFTER_ARCHIVE'],
        [chargedAfterTierDeletion.id, 'CHARGED_AFTER_TIER_DELETION'],
      ]);
      expect(orders.map(order => order.id)).to.not.include(keptOnDeletedTier.id);
    });

    it('can be restricted to a collective and to specific orders', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id, slug: 'target-collective' });
      const otherCollective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await fakeBrokenCancellation({ CollectiveId: collective.id });
      const otherOrder = await fakeBrokenCancellation({ CollectiveId: otherCollective.id });

      const forCollective = await findOrdersToFlag({ collectiveSlug: 'target-collective' });
      expect(forCollective.map(o => o.id)).to.deep.equal([order.id]);

      const forOrders = await findOrdersToFlag({ orderIds: [otherOrder.id] });
      expect(forOrders.map(o => o.id)).to.deep.equal([otherOrder.id]);

      const limited = await findOrdersToFlag({ limit: 1 });
      expect(limited).to.have.length(1);
    });
  });

  describe('flagOrdersForAsyncDeactivation', () => {
    it('flags the orders for a silent asynchronous deactivation', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await fakeBrokenCancellation({ CollectiveId: collective.id });

      // Backdate the order to make sure `updatedAt` is bumped: the 10-minute job only looks one month back
      await sequelize.query(`UPDATE "Orders" SET "updatedAt" = NOW() - INTERVAL '2 months' WHERE id = :id`, {
        replacements: { id: order.id },
      });
      const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

      await flagOrdersForAsyncDeactivation([order.id]);

      await order.reload();
      expect(order.status).to.equal(OrderStatuses.CANCELLED);
      expect(order.data.needsAsyncDeactivation).to.be.true;
      expect(order.data.createStatusChangeActivity).to.be.false;
      expect(order.updatedAt.getTime()).to.be.greaterThan(twoMonthsAgo.getTime());

      // And it is not reported anymore
      expect((await findOrdersToFlag()).map(o => o.id)).to.not.include(order.id);
    });

    it('moves orders charged after their cancellation back to CANCELLED', async () => {
      const archivedAccount = await fakeCollective({ deactivatedAt: new Date() });
      const order = await fakeOrder(
        { FromCollectiveId: archivedAccount.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );

      await flagOrdersForAsyncDeactivation([order.id]);

      await order.reload();
      expect(order.status).to.equal(OrderStatuses.CANCELLED);
      expect(order.data.needsAsyncDeactivation).to.be.true;
    });

    it('does nothing when there is no order to flag', async () => {
      const order = await fakeBrokenCancellation();
      await flagOrdersForAsyncDeactivation([]);

      await order.reload();
      expect(order.data?.needsAsyncDeactivation).to.not.exist;
    });
  });
});
