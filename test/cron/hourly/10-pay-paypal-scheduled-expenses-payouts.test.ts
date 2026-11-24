import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { run as payPaypalScheduledExpenses } from '../../../cron/hourly/10-pay-paypal-scheduled-expenses-payouts';
import activities from '../../../server/constants/activities';
import status from '../../../server/constants/expense-status';
import MemberRoles from '../../../server/constants/roles';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import models from '../../../server/models';
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

  /** A PayPal expense scheduled for payment by `scheduledBy`, as `scheduleExpenseForPayment` does */
  const fakeScheduledExpense = async (collective, scheduledBy, expenseData = {}) => {
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
});
