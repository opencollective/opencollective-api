import { expect } from 'chai';
import config from 'config';
import { pick } from 'lodash';
import moment from 'moment';
import sinon from 'sinon';

import { expenseStatus, expenseTypes } from '../../../server/constants';
import models from '../../../server/models';
import Expense from '../../../server/models/Expense';
import {
  fakeCollective,
  fakeExpense,
  fakeExpenseItem,
  fakePaidExpense,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors } from '../../utils';

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

  describe('getCollectiveExpensesTags and getCollectiveExpensesTagsTimeSeries', () => {
    let collective;
    const sandbox = sinon.createSandbox();

    before(async () => {
      await resetTestDB();
      await seedDefaultVendors();
      sandbox.stub(config.ledger, 'separatePaymentProcessorFees').value(true);

      collective = await fakeCollective();
      await fakePaidExpense({
        CollectiveId: collective.id,
        createdAt: moment().subtract(1, 'days'),
        amount: 200,
        tags: ['food', 'team'],
        paymentProcessorFeeInHostCurrency: 10,
      });
      await fakePaidExpense({
        CollectiveId: collective.id,
        createdAt: moment().subtract(2, 'days'),
        amount: 400,
        tags: ['food', 'team'],
        paymentProcessorFeeInHostCurrency: 20,
      });
      await fakePaidExpense({
        CollectiveId: collective.id,
        createdAt: moment().subtract(3, 'days'),
        amount: 800,
        tags: ['team', 'office'],
        paymentProcessorFeeInHostCurrency: 40,
      });
    });

    after(() => sandbox.restore());

    it('should return all tags for a collective expenses', async () => {
      const tags = await Expense.getCollectiveExpensesTags(collective);

      expect(tags).to.deep.eq([
        { label: 'team', count: 3, amount: 1400, currency: 'USD' },
        { label: 'office', count: 1, amount: 800, currency: 'USD' },
        { label: 'food', count: 2, amount: 600, currency: 'USD' },
      ]);
    });

    it('should return all tags for a collective expenses filtered by date', async () => {
      const tags = await Expense.getCollectiveExpensesTags(collective, {
        dateFrom: moment().subtract(2.5, 'days').toDate(),
      });

      expect(tags).to.deep.eq([
        { label: 'food', count: 2, amount: 600, currency: 'USD' },
        { label: 'team', count: 2, amount: 600, currency: 'USD' },
      ]);
    });

    it('should return the time series of tags for a collective expenses', async () => {
      const timeSeries = await Expense.getCollectiveExpensesTagsTimeSeries(collective, 'day').catch(console.error);

      expect(timeSeries).to.deep.eq([
        {
          date: moment.utc().subtract(1, 'days').startOf('day').toDate(),
          label: 'food',
          count: 1,
          amount: 200,
          currency: 'USD',
        },
        {
          date: moment.utc().subtract(1, 'days').startOf('day').toDate(),
          label: 'team',
          count: 1,
          amount: 200,
          currency: 'USD',
        },
        {
          date: moment.utc().subtract(2, 'days').startOf('day').toDate(),
          label: 'food',
          count: 1,
          amount: 400,
          currency: 'USD',
        },
        {
          date: moment.utc().subtract(2, 'days').startOf('day').toDate(),
          label: 'team',
          count: 1,
          amount: 400,
          currency: 'USD',
        },
        {
          date: moment.utc().subtract(3, 'days').startOf('day').toDate(),
          label: 'office',
          count: 1,
          amount: 800,
          currency: 'USD',
        },
        {
          date: moment.utc().subtract(3, 'days').startOf('day').toDate(),
          label: 'team',
          count: 1,
          amount: 800,
          currency: 'USD',
        },
      ]);
    });

    it('should return the time series of tags for a collective expenses filtered by date', async () => {
      const timeSeries = await Expense.getCollectiveExpensesTagsTimeSeries(collective, 'day', {
        dateFrom: moment().subtract(2.5, 'days').toDate(),
      });

      expect(timeSeries).to.deep.eq([
        {
          date: moment.utc().subtract(1, 'days').startOf('day').toDate(),
          label: 'food',
          count: 1,
          amount: 200,
          currency: 'USD',
        },
        {
          date: moment.utc().subtract(1, 'days').startOf('day').toDate(),
          label: 'team',
          count: 1,
          amount: 200,
          currency: 'USD',
        },
        {
          date: moment.utc().subtract(2, 'days').startOf('day').toDate(),
          label: 'food',
          count: 1,
          amount: 400,
          currency: 'USD',
        },
        {
          date: moment.utc().subtract(2, 'days').startOf('day').toDate(),
          label: 'team',
          count: 1,
          amount: 400,
          currency: 'USD',
        },
      ]);
    });
  });
});
