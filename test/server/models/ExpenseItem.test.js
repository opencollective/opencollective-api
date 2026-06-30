import { expect } from 'chai';

import ExpenseType from '../../../server/constants/expense-type';
import models from '../../../server/models';
import { sanitizeExpenseItemDescription } from '../../../server/models/ExpenseItem';
import { randUrl } from '../../stores';
import { fakeExpense, fakeUser } from '../../test-helpers/fake-data';

describe('test/server/models/ExpenseItem', () => {
  describe('sanitizeExpenseItemDescription', () => {
    it('strips HTML from non-grant item descriptions', () => {
      const description = '</td></tr></table><a href="https://attacker.example.com/phish">Click</a>';
      expect(sanitizeExpenseItemDescription(description, ExpenseType.INVOICE)).to.eq('Click');
    });

    it('sanitizes allowed HTML for grant item descriptions', () => {
      expect(sanitizeExpenseItemDescription('<strong>Scope</strong>', ExpenseType.GRANT)).to.eq(
        '<strong>Scope</strong>',
      );
    });

    it('removes disallowed HTML for grant item descriptions', () => {
      const description = '<script>alert(1)</script></td></tr></table><strong>Scope</strong>';
      const sanitized = sanitizeExpenseItemDescription(description, ExpenseType.GRANT);
      expect(sanitized).to.not.include('<script>');
      expect(sanitized).to.not.include('</td></tr></table>');
      expect(sanitized).to.include('<strong>Scope</strong>');
    });
  });

  describe('createFromData', () => {
    it('Filters out the bad fields', async () => {
      const expense = await fakeExpense();
      const user = await fakeUser();
      const data = {
        url: randUrl(),
        amount: 1500,
        incurredAt: new Date('2000-01-01T00:00:00'),
        deletedAt: new Date('2000-01-01T00:00:00'),
        currency: 'NZD',
      };

      const item = await models.ExpenseItem.createFromData(data, user, expense);
      expect(item.url).to.equal(data.url);
      expect(item.amount).to.equal(data.amount);
      expect(item.incurredAt.getTime()).to.equal(data.incurredAt.getTime());
      expect(item.deletedAt).to.be.null;
      expect(item.currency).to.equal(data.currency);
    });
  });
});
