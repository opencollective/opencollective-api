import { expect } from 'chai';
import moment from 'moment';

import OrderStatuses from '../../../../server/constants/order-status';
import { generateTierAvailableQuantityLoader } from '../../../../server/graphql/loaders/tiers';
import { refundTransaction } from '../../../../server/lib/payments';
import { sequelize } from '../../../../server/models';
import { fakeOrder, fakeTier } from '../../../test-helpers/fake-data';

describe('server/graphql/loaders/tiers', () => {
  describe('availableQuantity', () => {
    it('returns null if there is no limit', async () => {
      const loader = generateTierAvailableQuantityLoader();
      const tier = await fakeTier({
        type: 'TICKET',
        name: 'Event Ticket',
        amount: 1000,
        maxQuantity: null,
      });

      const availableQuantity = await loader.load(tier.id);
      expect(availableQuantity).to.equal(null);
    });

    it('correctly calculates available quantity after refunds', async () => {
      let loader = generateTierAvailableQuantityLoader();

      // Create a tier with limited quantity
      const tier = await fakeTier({
        type: 'TICKET',
        name: 'Event Ticket',
        amount: 1000,
        maxQuantity: 10,
      });

      // Create an order for 3 tickets
      const order = await fakeOrder(
        {
          description: 'Event tickets',
          totalAmount: 3000,
          currency: 'USD',
          TierId: tier.id,
          quantity: 3,
          status: OrderStatuses.PAID,
          processedAt: new Date(),
        },
        {
          withTransactions: true,
        },
      );

      // Check available quantity after purchase
      const availableAfterPurchase = await loader.load(tier.id);
      expect(availableAfterPurchase).to.equal(7); // 10 - 3 = 7

      // Refund
      const [mainTransaction] = await order.getTransactions({ where: { kind: 'CONTRIBUTION', type: 'CREDIT' } });
      await refundTransaction(mainTransaction);

      // Check available quantity after refund
      loader = generateTierAvailableQuantityLoader();
      const availableAfterRefund = await loader.load(tier.id);
      expect(availableAfterRefund).to.equal(10); // Should be back to 10
    });

    it('does not count paused orders', async () => {
      const tier = await fakeTier({ maxQuantity: 10 });
      await fakeOrder({ TierId: tier.id, status: OrderStatuses.ACTIVE }, { withTransactions: true });
      await fakeOrder({ TierId: tier.id, status: OrderStatuses.PAUSED }, { withTransactions: true });

      const loader = generateTierAvailableQuantityLoader();
      const availableQuantity = await loader.load(tier.id);
      expect(availableQuantity).to.equal(9); // Only 1 taken
    });

    it('only counts new/processing orders for a limited time', async () => {
      const tier = await fakeTier({ maxQuantity: 10 });
      await fakeOrder({ TierId: tier.id, status: OrderStatuses.NEW }, { withTransactions: true });
      await fakeOrder({ TierId: tier.id, status: OrderStatuses.PROCESSING }, { withTransactions: true });
      const oldNewOrder = await fakeOrder({ TierId: tier.id, status: OrderStatuses.NEW }, { withTransactions: true });
      const oldProcessingOrder = await fakeOrder(
        { TierId: tier.id, status: OrderStatuses.PROCESSING },
        { withTransactions: true },
      );

      const aWeekAgo = moment().subtract(1, 'week').toDate();
      await sequelize.query(`UPDATE "Orders" SET "createdAt" = :date, "updatedAt" = :date WHERE "id" IN (:ids)`, {
        replacements: { date: aWeekAgo, ids: [oldNewOrder.id, oldProcessingOrder.id] },
        type: sequelize.QueryTypes.UPDATE,
      });

      const loader = generateTierAvailableQuantityLoader();
      const availableQuantity = await loader.load(tier.id);
      expect(availableQuantity).to.equal(8); // Only one "NEW" and one "PROCESSING" recent order
    });
  });
});
