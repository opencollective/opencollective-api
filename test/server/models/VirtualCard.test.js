import { expect } from 'chai';

import { fakeExpense, fakeVirtualCard } from '../../test-helpers/fake-data';

describe('server/models/VirtualCard', () => {
  describe('getExpensesMissingDetails()', () => {
    let virtualCard;

    before(async () => {
      virtualCard = await fakeVirtualCard();
    });

    it('finds expenses missing details', async () => {
      let missing = await virtualCard.getExpensesMissingDetails();
      expect(missing).to.have.length(0);

      const expense = await fakeExpense({ VirtualCardId: virtualCard.id, data: { missingDetails: true } });

      missing = await virtualCard.getExpensesMissingDetails();
      expect(missing).to.have.length(1);
      expect(missing[0]).to.have.property('id', expense.id);

      await expense.update({ data: { missingDetails: false } });

      missing = await virtualCard.getExpensesMissingDetails();
      expect(missing).to.have.length(0);
    });
  });
});
