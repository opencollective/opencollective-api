import { expect } from 'chai';
import moment from 'moment';
import { createSandbox } from 'sinon';

import emailLib from '../../../server/lib/email';
import models from '../../../server/models';
import { fakeExpense, fakeRecurringExpense } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('server/models/RecurringExpense', () => {
  let sandbox, emailSendMessageSpy;
  let expense, recurringExpense;

  beforeEach(async () => {
    await utils.resetTestDB();

    sandbox = createSandbox();
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    expense = await fakeExpense({ status: 'PAID', description: 'Paycheck 2000' });
    recurringExpense = await models.RecurringExpense.createFromExpense(
      expense,
      models.RecurringExpense.RecurringExpenseIntervals.MONTH,
    );
  });

  afterEach(() => {
    sandbox.restore?.();
  });

  it('creates RecurringExpense from Expense and interval', async () => {
    expect(recurringExpense.CollectiveId).to.eq(expense.CollectiveId);
    expect(recurringExpense.FromCollectiveId).to.eq(expense.FromCollectiveId);
  });

  it('creates the next expense', async () => {
    const newExpense = await recurringExpense.createNextExpense();

    expect(newExpense.CollectiveId).to.eq(expense.CollectiveId);
    expect(newExpense.FromCollectiveId).to.eq(expense.FromCollectiveId);
    expect(newExpense.PayoutMethodId).to.eq(expense.PayoutMethodId);
    expect(newExpense.RecurringExpenseId).to.eq(expense.RecurringExpenseId);
    expect(newExpense.amount).to.eq(expense.amount);
    expect(newExpense.status).to.eq('DRAFT');
    expect(newExpense).to.have.nested.property('data.draftKey');
    expect(newExpense).to.have.nested.property('data.items');
    expect(newExpense.data.items.map(i => i.amount)).to.deep.eqInAnyOrder(expense.items.map(i => i.amount));
  });

  it('should mail the user notifying about a new draft', async () => {
    const newExpense = await recurringExpense.createNextExpense();
    await utils.waitForCondition(() => emailSendMessageSpy.firstCall);

    const [, subject, body] = emailSendMessageSpy.firstCall.args;
    expect(subject).to.include('Your recurring expense');
    expect(subject).to.include('was drafted');
    expect(body).to.include(`/expenses/${newExpense.id}?key&#x3D;${newExpense.data.draftKey}"`);
  });

  it('returns the last recurring Expense', async () => {
    const newExpense = await recurringExpense.createNextExpense();
    const lastExpense = await recurringExpense.getLastExpense();
    expect(lastExpense.id).to.eq(newExpense.id);
  });

  it('returns all due RecurringExpenses', async () => {
    const recurringExpense = await fakeRecurringExpense({
      interval: 'month',
      lastDraftedAt: moment(),
    } as any);
    let dueRecurringExpenses = await models.RecurringExpense.getRecurringExpensesDue();
    expect(dueRecurringExpenses).to.have.length(0);

    await recurringExpense.update({ lastDraftedAt: moment().subtract(1, 'month') });
    dueRecurringExpenses = await models.RecurringExpense.getRecurringExpensesDue();
    expect(dueRecurringExpenses).to.have.length(1);
  });

  it('creates an open-ended recurring expense when endsAt is not set', async () => {
    await recurringExpense.reload();
    expect(recurringExpense.endsAt).to.be.null;
  });

  it('stores a future endsAt', async () => {
    const endsAt = moment().add(1, 'year').toDate();
    const futureRecurringExpense = await models.RecurringExpense.createFromExpense(
      expense,
      models.RecurringExpense.RecurringExpenseIntervals.MONTH,
      endsAt,
    );
    expect(futureRecurringExpense.endsAt.getTime()).to.eq(endsAt.getTime());
  });

  it('accepts endsAt as an ISO string', async () => {
    const endsAt = moment().add(1, 'month').toISOString();
    const recurringExpenseWithEndDate = await models.RecurringExpense.createFromExpense(
      expense,
      models.RecurringExpense.RecurringExpenseIntervals.MONTH,
      endsAt,
    );
    expect(recurringExpenseWithEndDate.endsAt.getTime()).to.eq(moment(endsAt).valueOf());
  });

  it('rejects a past endsAt', async () => {
    await expect(
      models.RecurringExpense.createFromExpense(
        expense,
        models.RecurringExpense.RecurringExpenseIntervals.MONTH,
        moment().subtract(1, 'day').toDate(),
      ),
    ).to.be.rejectedWith(/The end date for a recurring expense must be later than its first recurrence/);
  });

  it('rejects an endsAt that cannot reach the first possible due run', async () => {
    // A monthly recurring expense created now is first drafted in a month: an end date
    // before that can never produce a single draft, even though it is in the future.
    await expect(
      models.RecurringExpense.createFromExpense(
        expense,
        models.RecurringExpense.RecurringExpenseIntervals.MONTH,
        moment().add(2, 'weeks').toDate(),
      ),
    ).to.be.rejectedWith(/The end date for a recurring expense must be later than its first recurrence/);
  });

  it('uses the interval to determine the first possible due run', async () => {
    // The same end date is valid for a weekly recurring expense (due in a week) but not
    // for a monthly one (not due before next month).
    const endsAt = moment().add(2, 'weeks').toDate();
    const weeklyRecurringExpense = await models.RecurringExpense.createFromExpense(
      expense,
      models.RecurringExpense.RecurringExpenseIntervals.WEEK,
      endsAt,
    );
    expect(weeklyRecurringExpense.endsAt.getTime()).to.eq(endsAt.getTime());
    await expect(
      models.RecurringExpense.createFromExpense(
        expense,
        models.RecurringExpense.RecurringExpenseIntervals.MONTH,
        endsAt,
      ),
    ).to.be.rejectedWith(/must be later than its first recurrence/);
  });

  it('rejects an invalid endsAt', async () => {
    await expect(
      models.RecurringExpense.createFromExpense(
        expense,
        models.RecurringExpense.RecurringExpenseIntervals.MONTH,
        'not-a-date',
      ),
    ).to.be.rejectedWith('Invalid end date for the recurring expense');
  });

  it('picks up open-ended recurring expenses as due after one interval', async () => {
    // Regression test for https://github.com/opencollective/opencollective/issues/8907:
    // stamping endsAt with the submission time excluded the row from
    // getRecurringExpensesDue() forever. With endsAt null, the row becomes due.
    await recurringExpense.update({ lastDraftedAt: moment().subtract(1, 'month').toDate() });
    const dueRecurringExpenses = await models.RecurringExpense.getRecurringExpensesDue();
    expect(dueRecurringExpenses.map(({ id }) => id)).to.include(recurringExpense.id);
  });

  it('does not pick up recurring expenses that already ended', async () => {
    const endedRecurringExpense = await fakeRecurringExpense({
      interval: 'month',
      endsAt: moment().subtract(1, 'month').toDate(),
      lastDraftedAt: moment().subtract(2, 'months').toDate(),
    } as any);
    const dueRecurringExpenses = await models.RecurringExpense.getRecurringExpensesDue();
    expect(dueRecurringExpenses.map(({ id }) => id)).to.not.include(endedRecurringExpense.id);
  });
});
