import { expect } from 'chai';
import moment from 'moment';

import { fakeExpense, fakeVirtualCard } from '../../test-helpers/fake-data.js';

describe('server/models/VirtualCard', () => {
  describe('getExpensesMissingDetails()', () => {
    let virtualCard;

    before(async () => {
      virtualCard = await fakeVirtualCard();
    });

    it('finds expenses missing details older than 30 days', async () => {
      let missing = await virtualCard.getExpensesMissingDetails();
      expect(missing).to.have.length(0);

      const expense = await fakeExpense({
        VirtualCardId: virtualCard.id,
        type: 'CHARGE',
        status: 'PAID',
        createdAt: moment.utc().subtract(31, 'days'),
        items: [{ amount: 10000 }],
      });
      const chargeItem = expense.items[0];
      await chargeItem.update({ url: null });

      missing = await virtualCard.getExpensesMissingDetails();
      expect(missing).to.have.length(1);
      expect(missing[0]).to.have.property('id', expense.id);

      await chargeItem.update({ url: 'fake.url' });

      missing = await virtualCard.getExpensesMissingDetails();
      expect(missing).to.have.length(0);
    });
  });
});
