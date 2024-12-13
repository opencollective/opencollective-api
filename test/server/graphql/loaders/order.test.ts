import { expect } from 'chai';

import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { generateOrderTotalContributedLoader } from '../../../../server/graphql/loaders/order';
import { fakeCollective, fakeOrder, fakeTransaction, multiple } from '../../../test-helpers/fake-data';

describe('server/graphql/loaders/order', () => {
  describe('generateOrderTotalContributedLoader', () => {
    let order;
    before(async () => {
      const collective = await fakeCollective();
      const orders = await multiple(
        fakeOrder,
        4,
        { CollectiveId: collective.id, totalAmount: 1000 },
        { withTransactions: true },
      );
      order = orders[0];
      await multiple(fakeTransaction, 2, {
        OrderId: order.id,
        amount: 500,
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        HostCollectiveId: collective.HostCollectiveId,
        FromCollectiveId: order.FromCollectiveId,
      });
    });

    it('returns the total amount contributed by a specifc order', async () => {
      const loaded = await generateOrderTotalContributedLoader().load(order.id);

      expect(loaded).to.equal(2000);
    });

    it('returns undefined if order is not found', async () => {
      const loaded = await generateOrderTotalContributedLoader().load(12312312312);

      expect(loaded).to.equal(undefined);
    });
  });
});
