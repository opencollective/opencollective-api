import { expect } from 'chai';
import { pick } from 'lodash';

import models from '../../../server/models';
import { fakeCollective, fakeExpense, fakeUser } from '../../test-helpers/fake-data';

describe('test/server/models/Expense', () => {
  describe('Create', () => {
    let user, collective, validExpenseData;

    before(async () => {
      user = await fakeUser();
      collective = await fakeCollective();
      validExpenseData = {
        description: 'A valid expense',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        type: 'INVOICE',
        amount: 4200,
        currency: 'EUR',
        UserId: user.id,
        lastEditedById: user.id,
        incurredAt: new Date(),
        invoiceInfo: 'This will be printed on your invoice',
        payeeLocation: {
          country: 'FR',
          address: 'A valid address',
        },
      };
    });

    it('creates a valid expense', async () => {
      const expense = await models.Expense.create(validExpenseData);
      expect(pick(expense.dataValues, Object.keys(validExpenseData))).to.deep.eq(validExpenseData);
    });

    it('Enforces payee location for INVOICE', async () => {
      // Empty address
      await expect(
        models.Expense.create({ ...validExpenseData, payeeLocation: { address: '', country: 'BE' } }),
      ).to.be.eventually.rejectedWith(
        'Expenses with "Invoice" type must have a valid address and country for payee\'s location',
      );
      // Address with only spaces
      await expect(
        models.Expense.create({ ...validExpenseData, payeeLocation: { address: '      ', country: 'BE' } }),
      ).to.be.eventually.rejectedWith(
        'Expenses with "Invoice" type must have a valid address and country for payee\'s location',
      );
      // Empty country
      await expect(
        models.Expense.create({ ...validExpenseData, payeeLocation: { address: 'xxxxxx', country: '' } }),
      ).to.be.eventually.rejectedWith(
        'Expenses with "Invoice" type must have a valid address and country for payee\'s location',
      );
      // Empty object
      await expect(models.Expense.create({ ...validExpenseData, payeeLocation: null })).to.be.eventually.rejectedWith(
        'Expenses with "Invoice" type must have a valid address and country for payee\'s location',
      );
    });
  });

  describe('Delete', () => {
    it('Deleting an expense deletes its items', async () => {
      const expense = await fakeExpense();
      await expense.destroy();
      for (const item of expense.items) {
        await item.reload({ paranoid: false });
        expect(item.deletedAt).to.not.be.null;
      }
    });
  });

  describe('Transformations', () => {
    it('Trims description', async () => {
      const expense = await fakeExpense({ description: '    Trim me!      ' });
      expect(expense.description).to.eq('Trim me!');
    });
  });
});
