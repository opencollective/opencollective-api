import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { run as payPaypalScheduledExpenses } from '../../../cron/hourly/10-pay-paypal-scheduled-expenses-payouts';
import activities from '../../../server/constants/activities';
import status from '../../../server/constants/expense-status';
import MemberRoles from '../../../server/constants/roles';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import models, { sequelize } from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import * as paypal from '../../../server/paymentProviders/paypal/payouts';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeExpense,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('cron/hourly/10-pay-paypal-scheduled-expenses-payouts', () => {
  const sandbox = createSandbox();
  let payExpensesBatch;

  afterEach(sandbox.restore);
  beforeEach(utils.resetTestDB);
  beforeEach(() => {
    payExpensesBatch = sandbox.stub(paypal, 'payExpensesBatch').resolves();
  });

  const fakePaypalPayoutMethod = () =>
    fakePayoutMethod({ type: PayoutMethodTypes.PAYPAL, data: { email: 'nicolas@cage.com' } });

  /** A host with an admin, and a collective with `balance` that it hosts */
  const fakeHostAndCollective = async ({ balance = 1000_00 } = {}) => {
    const hostAdmin = await fakeUser();
    const host = await fakeActiveHost({ admin: hostAdmin, currency: 'USD' });
    const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
    if (balance) {
      await fakeTransaction({
        type: 'CREDIT',
        kind: TransactionKind.CONTRIBUTION,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: balance,
        amountInHostCurrency: balance,
        netAmountInCollectiveCurrency: balance,
        currency: 'USD',
        hostCurrency: 'USD',
      });
    }

    return { host, hostAdmin, collective };
  };

  /**
   * A PayPal expense scheduled for payment by `scheduledBy`, as `scheduleExpenseForPayment` does. It was scheduled an
   * hour ago, unless `justScheduled` is set.
   */
  const fakeScheduledExpense = async (
    collective,
    scheduledBy,
    { justScheduled = false, ...expenseData }: { justScheduled?: boolean; type?: string; feesPayer?: string } = {},
  ) => {
    const payoutMethod = await fakePaypalPayoutMethod();
    const expense = await fakeExpense({
      status: status.SCHEDULED_FOR_PAYMENT,
      amount: 100_00,
      CollectiveId: collective.id,
      currency: 'USD',
      PayoutMethodId: payoutMethod.id,
      type: 'INVOICE',
      ...expenseData,
    });
    if (scheduledBy) {
      await fakeActivity({
        type: activities.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT,
        ExpenseId: expense.id,
        CollectiveId: collective.id,
        UserId: scheduledBy.id,
      });
    }

    if (!justScheduled) {
      await sequelize.query(`UPDATE "Expenses" SET "updatedAt" = NOW() - INTERVAL '1 hour' WHERE "id" = :id`, {
        replacements: { id: expense.id },
      });
    }

    return expense;
  };

  const getPaidExpenseIds = () => payExpensesBatch.getCalls().flatMap(call => call.args[0].map(e => e.id));

  const getUnscheduledActivity = expense =>
    models.Activity.findOne({
      where: { ExpenseId: expense.id, type: activities.COLLECTIVE_EXPENSE_UNSCHEDULED_FOR_PAYMENT },
    });

  it('bundle expenses by hostId', async () => {
    for (let i = 0; i < 2; i++) {
      const { hostAdmin, collective } = await fakeHostAndCollective();
      for (let j = 0; j < 3; j++) {
        await fakeScheduledExpense(collective, hostAdmin);
      }
    }

    await payPaypalScheduledExpenses();

    expect(payExpensesBatch.callCount).to.eq(2);
    for (let call = 0; call < payExpensesBatch.callCount; call++) {
      const args = payExpensesBatch.getCall(call).args[0];
      const hostIds = args.map(c => c.collective.HostCollectiveId);
      expect(hostIds).to.have.length(3);
      expect(hostIds.every(id => id === hostIds[0])).to.be.true;
    }
  });

  it('does not pay payouts scheduled by a user who is no longer an admin of the host', async () => {
    const { host, hostAdmin, collective } = await fakeHostAndCollective();
    const otherAdmin = await fakeUser();
    await host.addUserWithRole(otherAdmin, MemberRoles.ADMIN);

    const expenseFromRemovedAdmin = await fakeScheduledExpense(collective, otherAdmin);
    const expenseFromAdmin = await fakeScheduledExpense(collective, hostAdmin);
    await models.Member.destroy({ where: { MemberCollectiveId: otherAdmin.CollectiveId, CollectiveId: host.id } });

    await payPaypalScheduledExpenses();

    expect(getPaidExpenseIds()).to.deep.eq([expenseFromAdmin.id]);
    await expenseFromRemovedAdmin.reload();
    expect(expenseFromRemovedAdmin.status).to.eq(status.APPROVED);
    const activity = await getUnscheduledActivity(expenseFromRemovedAdmin);
    expect(activity.data.message).to.eq('The admin who scheduled this payout is no longer an admin of the host');
  });

  it('unschedules the payouts of a collective that is not hosted anymore', async () => {
    const { hostAdmin, collective } = await fakeHostAndCollective();
    const expense = await fakeScheduledExpense(collective, hostAdmin);
    await collective.update({ HostCollectiveId: null, approvedAt: null, isActive: false });

    await payPaypalScheduledExpenses();

    expect(payExpensesBatch.called).to.be.false;
    await expense.reload();
    expect(expense.status).to.eq(status.APPROVED);
    const activity = await getUnscheduledActivity(expense);
    expect(activity.data.message).to.eq('The collective is not hosted anymore');
  });

  it('does not pay payouts without a record of who scheduled them', async () => {
    const { collective } = await fakeHostAndCollective();
    const expense = await fakeScheduledExpense(collective, null);

    await payPaypalScheduledExpenses();

    expect(payExpensesBatch.called).to.be.false;
    await expense.reload();
    expect(expense.status).to.eq(status.APPROVED);
  });

  it('only pays the payouts that the collective can still cover', async () => {
    // Enough for the first two expenses (2 x $100) only
    const { hostAdmin, collective } = await fakeHostAndCollective({ balance: 250_00 });
    const expenses = [];
    for (let i = 0; i < 3; i++) {
      expenses.push(await fakeScheduledExpense(collective, hostAdmin));
    }

    await payPaypalScheduledExpenses();

    expect(getPaidExpenseIds()).to.deep.eq([expenses[0].id, expenses[1].id]);
    await expenses[2].reload();
    expect(expenses[2].status).to.eq(status.APPROVED);
    const activity = await getUnscheduledActivity(expenses[2]);
    expect(activity.data.message).to.eq('The collective does not have enough funds to pay this expense anymore');
  });

  it('counts the PayPal fee the collective pays when checking the balance', async () => {
    // A $100 payout with a $2 fee (2%) paid by the collective needs $102
    const { hostAdmin: shortAdmin, collective: shortCollective } = await fakeHostAndCollective({ balance: 101_00 });
    const notCovered = await fakeScheduledExpense(shortCollective, shortAdmin, { feesPayer: 'COLLECTIVE' });
    const { hostAdmin, collective } = await fakeHostAndCollective({ balance: 102_00 });
    const covered = await fakeScheduledExpense(collective, hostAdmin, { feesPayer: 'COLLECTIVE' });

    await payPaypalScheduledExpenses();

    expect(getPaidExpenseIds()).to.deep.eq([covered.id]);
    await notCovered.reload();
    expect(notCovered.status).to.eq(status.APPROVED);
  });

  it('checks the admin recorded with the current scheduling, not an older scheduling activity', async () => {
    const { host, hostAdmin, collective } = await fakeHostAndCollective();
    const removedAdmin = await fakeUser();
    await host.addUserWithRole(removedAdmin, MemberRoles.ADMIN);
    // An older scheduling by a current admin, then the current one by an admin who has been removed since
    const expense = await fakeScheduledExpense(collective, hostAdmin);
    await expense.update({ data: { ...expense.data, scheduledForPaymentByUserId: removedAdmin.id } });
    await sequelize.query(`UPDATE "Expenses" SET "updatedAt" = NOW() - INTERVAL '1 hour' WHERE "id" = :id`, {
      replacements: { id: expense.id },
    });
    await models.Member.destroy({ where: { MemberCollectiveId: removedAdmin.CollectiveId, CollectiveId: host.id } });

    await payPaypalScheduledExpenses();

    expect(payExpensesBatch.called).to.be.false;
    await expense.reload();
    expect(expense.status).to.eq(status.APPROVED);
  });

  it('leaves alone a payout scheduled seconds ago that has no record yet of who scheduled it', async () => {
    const { collective } = await fakeHostAndCollective();
    const expense = await fakeScheduledExpense(collective, null, { justScheduled: true });

    await payPaypalScheduledExpenses();

    expect(payExpensesBatch.called).to.be.false;
    await expense.reload();
    expect(expense.status).to.eq(status.SCHEDULED_FOR_PAYMENT);
    expect(await getUnscheduledActivity(expense)).to.be.null;
  });

  it('pays settlements and platform bills whatever the balance, like when scheduling', async () => {
    const { hostAdmin, collective } = await fakeHostAndCollective({ balance: 0 });
    const settlement = await fakeScheduledExpense(collective, hostAdmin, { type: 'SETTLEMENT' });
    const platformBill = await fakeScheduledExpense(collective, hostAdmin, { type: 'PLATFORM_BILLING' });
    const invoice = await fakeScheduledExpense(collective, hostAdmin);

    await payPaypalScheduledExpenses();

    expect(getPaidExpenseIds()).to.have.members([settlement.id, platformBill.id]);
    await invoice.reload();
    expect(invoice.status).to.eq(status.APPROVED);
  });

  it('does not pay nor touch expenses that are not scheduled for payment anymore', async () => {
    const { host, collective } = await fakeHostAndCollective();
    // No record of who scheduled them: they would be put back to APPROVED if they were still scheduled
    const rejected = await fakeScheduledExpense(collective, null);
    const unscheduled = await fakeScheduledExpense(collective, null);
    const loadedByCron = await models.Expense.findAll({
      where: { id: [rejected.id, unscheduled.id] },
      include: [{ model: models.Collective, as: 'collective' }],
    });
    await rejected.update({ status: status.REJECTED });
    await unscheduled.update({ status: status.APPROVED });

    const toPay = await paypal.checkScheduledPayoutsBeforePaying(host, loadedByCron);

    expect(toPay).to.be.empty;
    await rejected.reload();
    expect(rejected.status).to.eq(status.REJECTED);
    expect(await getUnscheduledActivity(rejected)).to.be.null;
    expect(await getUnscheduledActivity(unscheduled)).to.be.null;
  });
});
