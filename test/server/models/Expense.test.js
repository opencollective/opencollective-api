import { expect } from 'chai';
import { pick } from 'lodash-es';

import { expenseStatus, expenseTypes } from '../../../server/constants/index.js';
import models from '../../../server/models/index.js';
import Expense from '../../../server/models/Expense.js';
import {
  fakeCollective,
  fakeExpense,
  fakeExpenseItem,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data.js';
import { resetTestDB } from '../../utils.js';

describe('test/server/models/Expense', () => {
  describe('Create', () => {
    it('creates a valid expense', async () => {
      const user = await fakeUser();
      const expenseData = {
        description: 'A valid expense',
        FromCollectiveId: user.CollectiveId,
        CollectiveId: (await fakeCollective()).id,
        type: 'INVOICE',
        amount: 4200,
        currency: 'EUR',
        UserId: user.id,
        lastEditedById: user.id,
        incurredAt: new Date(),
        invoiceInfo: 'This will be printed on your invoice',
      };

      const expense = await models.Expense.create(expenseData);
      expect(pick(expense.dataValues, Object.keys(expenseData))).to.deep.eq(expenseData);
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

  describe('findPendingCardCharges', () => {
    let pendingCharge;

    before(async () => {
      await resetTestDB();

      pendingCharge = await fakeExpense({ type: expenseTypes.CHARGE, status: expenseStatus.PAID });
      await fakeExpenseItem({ ExpenseId: pendingCharge.id, url: null });

      const completeCharge = await fakeExpense({ type: expenseTypes.CHARGE, status: expenseStatus.PAID });
      await fakeExpenseItem({ ExpenseId: completeCharge.id });
    });

    it('should return all pending card charges', async () => {
      const pendingCharges = await Expense.findPendingCardCharges();
      expect(pendingCharges).to.have.length(1);
      expect(pendingCharges[0]).to.have.property('id').eq(pendingCharge.id);
    });

    it('should return pending card charges for given attributes', async () => {
      const newPendingCharge = await fakeExpense({ type: expenseTypes.CHARGE, status: expenseStatus.PAID });
      await fakeExpenseItem({ ExpenseId: newPendingCharge.id, url: null });

      const pendingCharges = await Expense.findPendingCardCharges({
        where: {
          CollectiveId: newPendingCharge.CollectiveId,
        },
      });
      expect(pendingCharges).to.have.length(1);
      expect(pendingCharges[0]).to.have.property('id').eq(newPendingCharge.id);
    });

    it('should ignore expenses with refunded transactions', async () => {
      const refundedCharge = await fakeExpense({ type: expenseTypes.CHARGE, status: expenseStatus.PAID });
      await fakeExpenseItem({ ExpenseId: refundedCharge.id, url: null });
      await fakeTransaction({ ExpenseId: refundedCharge.id });
      await fakeTransaction({ ExpenseId: refundedCharge.id, isRefund: true });

      const pendingCharges = await Expense.findPendingCardCharges({
        where: {
          CollectiveId: refundedCharge.CollectiveId,
        },
      });

      expect(pendingCharges).to.have.length(0);
    });
  });
});
