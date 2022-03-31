import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import emailLib from '../../../server/lib/email';
import models from '../../../server/models';
import { fakeExpense, fakeRecurringExpense } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('server/models/RecurringExpense', () => {
  let sandbox, emailSendMessageSpy;
  let expense, recurringExpense, newExpense;

  before(async () => {
    await utils.resetTestDB();

    sandbox = createSandbox();
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    expense = await fakeExpense({ status: 'PAID', description: 'Paycheck 2000' });
  });

  after(() => {
    sandbox.restore?.();
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

  it('should mail the user notifying about a new draft', async () => {
    await utils.waitForCondition(() => emailSendMessageSpy.firstCall);

    const [, subject, body] = emailSendMessageSpy.firstCall.args;
    expect(subject).to.include('Your recurring expense');
    expect(subject).to.include('was drafted');
    expect(body).to.include(`/expenses/${newExpense.id}?key&#x3D;${newExpense.data.draftKey}"`);
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
