import { expect } from 'chai';

import {
  cancelAllActiveRecurringContributions,
  findActiveRecurringOrders,
} from '../../../scripts/recurring-contributions/cancel-all-active';
import { CollectiveType } from '../../../server/constants/collectives';
import OrderStatuses from '../../../server/constants/order-status';
import models from '../../../server/models';
import { fakeCollective, fakeHost, fakeOrder } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/recurring-contributions/cancel-all-active', () => {
  beforeEach(resetTestDB);

  describe('findActiveRecurringOrders', () => {
    it('returns active recurring orders for a collective and its children', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const child = await fakeCollective({
        type: CollectiveType.PROJECT,
        ParentCollectiveId: collective.id,
        HostCollectiveId: host.id,
      });

      const activeOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      const childActiveOrder = await fakeOrder(
        { CollectiveId: child.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      const paidOrder = await fakeOrder({ CollectiveId: collective.id, status: OrderStatuses.PAID });
      const cancelledOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.CANCELLED },
        { withSubscription: true },
      );

      const orders = await findActiveRecurringOrders(collective.id);

      expect(orders.map(order => order.id).sort()).to.deep.equal([activeOrder.id, childActiveOrder.id].sort());
      expect(orders.map(order => order.id)).to.not.include(paidOrder.id);
      expect(orders.map(order => order.id)).to.not.include(cancelledOrder.id);
    });

    it('can exclude child collectives', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const child = await fakeCollective({
        type: CollectiveType.PROJECT,
        ParentCollectiveId: collective.id,
        HostCollectiveId: host.id,
      });

      const activeOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      await fakeOrder({ CollectiveId: child.id, status: OrderStatuses.ACTIVE }, { withSubscription: true });

      const orders = await findActiveRecurringOrders(collective.id, { includeChildren: false });

      expect(orders.map(order => order.id)).to.deep.equal([activeOrder.id]);
    });
  });

  describe('cancelAllActiveRecurringContributions', () => {
    it('runs in dry run mode without making changes', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const activeOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );

      const result = await cancelAllActiveRecurringContributions(collective.slug, {
        isDryRun: true,
        reason: 'Testing dry run',
      });

      expect(result.cancelledOrderIds).to.deep.equal([]);

      await activeOrder.reload({ include: [models.Subscription] });
      expect(activeOrder.status).to.equal(OrderStatuses.ACTIVE);
      expect(activeOrder.Subscription.isActive).to.be.true;
      expect(activeOrder.data?.needsAsyncDeactivation).to.not.exist;
    });

    it('cancels all active recurring contributions', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const child = await fakeCollective({
        type: CollectiveType.PROJECT,
        ParentCollectiveId: collective.id,
        HostCollectiveId: host.id,
      });

      const activeOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      const childActiveOrder = await fakeOrder(
        { CollectiveId: child.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      const paidOrder = await fakeOrder({ CollectiveId: collective.id, status: OrderStatuses.PAID });

      const result = await cancelAllActiveRecurringContributions(collective.slug, {
        isDryRun: false,
        reason: 'Collective is closing',
        messageSource: 'HOST',
      });

      expect(result.cancelledOrderIds.sort()).to.deep.equal([activeOrder.id, childActiveOrder.id].sort());

      await activeOrder.reload();
      await childActiveOrder.reload();
      await paidOrder.reload();

      expect(activeOrder.status).to.equal(OrderStatuses.CANCELLED);
      expect(childActiveOrder.status).to.equal(OrderStatuses.CANCELLED);
      expect(paidOrder.status).to.equal(OrderStatuses.PAID);

      expect(activeOrder.data.messageForContributors).to.equal('Collective is closing');
      expect(activeOrder.data.messageSource).to.equal('HOST');
      expect(activeOrder.data.needsAsyncDeactivation).to.be.true;
      expect(activeOrder.data.createStatusChangeActivity).to.be.true;
    });

    it('only cancels contributions to the collective when children are excluded', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const child = await fakeCollective({
        type: CollectiveType.PROJECT,
        ParentCollectiveId: collective.id,
        HostCollectiveId: host.id,
      });

      const activeOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );
      const childActiveOrder = await fakeOrder(
        { CollectiveId: child.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );

      const result = await cancelAllActiveRecurringContributions(collective.slug, {
        isDryRun: false,
        includeChildren: false,
      });

      expect(result.cancelledOrderIds).to.deep.equal([activeOrder.id]);

      await activeOrder.reload();
      await childActiveOrder.reload();

      expect(activeOrder.status).to.equal(OrderStatuses.CANCELLED);
      expect(childActiveOrder.status).to.equal(OrderStatuses.ACTIVE);
    });

    it('skips cancellation activities when silent mode is enabled', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const activeOrder = await fakeOrder(
        { CollectiveId: collective.id, status: OrderStatuses.ACTIVE },
        { withSubscription: true },
      );

      await cancelAllActiveRecurringContributions(collective.slug, {
        isDryRun: false,
        silent: true,
      });

      await activeOrder.reload();

      expect(activeOrder.status).to.equal(OrderStatuses.CANCELLED);
      expect(activeOrder.data.needsAsyncDeactivation).to.be.true;
      expect(activeOrder.data.createStatusChangeActivity).to.be.false;
    });

    it('returns an empty result when there are no active recurring contributions', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      await fakeOrder({ CollectiveId: collective.id, status: OrderStatuses.PAID });

      const result = await cancelAllActiveRecurringContributions(collective.slug, { isDryRun: false });

      expect(result.cancelledOrderIds).to.deep.equal([]);
    });

    it('throws when the collective is not found', async () => {
      await expect(
        cancelAllActiveRecurringContributions('non-existent-collective', { isDryRun: false }),
      ).to.be.rejectedWith('Collective non-existent-collective not found');
    });
  });
});
