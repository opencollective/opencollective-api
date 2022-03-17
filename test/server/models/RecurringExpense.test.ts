import { expect } from 'chai';
import moment from 'moment';

import models from '../../../server/models';
import { fakeExpense, fakeRecurringExpense } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('server/models/RecurringExpense', () => {
  let expense, recurringExpense, newExpense;

  before(async () => {
    await utils.resetTestDB();
    expense = await fakeExpense({ status: 'PAID' });
  });

  it('creates RecurringExpense from Expense and interval', async () => {
    recurringExpense = await models.RecurringExpense.createFromExpense(
      expense,
      models.RecurringExpense.RecurringExpenseIntervals.MONTH,
    );

    expect(recurringExpense.CollectiveId).to.eq(expense.CollectiveId);
    expect(recurringExpense.FromCollectiveId).to.eq(expense.FromCollectiveId);
  });

  it('creates the next expense', async () => {
    newExpense = await recurringExpense.createNextExpense();

    expect(newExpense.CollectiveId).to.eq(expense.CollectiveId);
    expect(newExpense.FromCollectiveId).to.eq(expense.FromCollectiveId);
    expect(newExpense.PayoutMethodId).to.eq(expense.PayoutMethodId);
    expect(newExpense.RecurringExpenseId).to.eq(expense.RecurringExpenseId);
    expect(newExpense.amount).to.eq(expense.amount);
    expect(newExpense.status).to.eq('DRAFT');
    expect(newExpense).to.have.nested.property('data.draftKey');
    expect(newExpense).to.have.nested.property('data.items');
    expect(newExpense.data.items[0].amount).to.eq(expense.items[0].amount);
  });

  it('returns the last recurring Expense', async () => {
    const lastExpense = await recurringExpense.getLastExpense();
    expect(lastExpense.id).to.eq(newExpense.id);
  });

  it('returns all due RecurringExpenses', async () => {
    const recurringExpense = await fakeRecurringExpense({
      interval: 'month',
      lastDraftedAt: moment(),
    });
    let dueRecurringExpenses = await models.RecurringExpense.getRecurringExpensesDue();
    expect(dueRecurringExpenses).to.have.length(0);

    await recurringExpense.update({ lastDraftedAt: moment().subtract(1, 'month') });
    dueRecurringExpenses = await models.RecurringExpense.getRecurringExpensesDue();
    expect(dueRecurringExpenses).to.have.length(1);
  });
});
