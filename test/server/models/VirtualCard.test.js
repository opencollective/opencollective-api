import { expect } from 'chai';
import moment from 'moment';

import { fakeExpense, fakeVirtualCard } from '../../test-helpers/fake-data';

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

  describe('info', () => {
    it('returns a public snapshot without private card details', async () => {
      const virtualCard = await fakeVirtualCard({
        name: 'Ops card',
        last4: '4242',
        privateData: { cardNumber: '4111111111114242', cvv: 'FAKESECRET_q3r4s5t6u7v8w9x0y1z2' },
      });

      expect(virtualCard.get('privateData')).to.deep.equal({
        cardNumber: '4111111111114242',
        cvv: 'FAKESECRET_q3r4s5t6u7v8w9x0y1z2',
      });
      expect(virtualCard.info).to.include({
        id: virtualCard.id,
        publicId: virtualCard.publicId,
        name: 'Ops card',
        last4: '4242',
        CollectiveId: virtualCard.CollectiveId,
        HostCollectiveId: virtualCard.HostCollectiveId,
      });
      expect(virtualCard.info).to.not.have.property('privateData');
      expect(virtualCard.info).to.not.have.property('cardNumber');
      expect(virtualCard.info).to.not.have.property('cvv');
    });
  });
});
