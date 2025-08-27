import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import { run } from '../../../cron/weekly/send-platform-billing-overdue-notifications';
import ActivityTypes from '../../../server/constants/activities';
import ExpenseStatus from '../../../server/constants/expense-status';
import ExpenseType from '../../../server/constants/expense-type';
import emailLib from '../../../server/lib/email';
import { sleep } from '../../../server/lib/utils';
import models from '../../../server/models';
import { fakeCollective, fakeExpense, fakePlatformBill, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB, waitForCondition } from '../../utils';

describe('cron/weekly/send-platform-billing-overdue-notifications', () => {
  let sandbox;
  let sendEmailSpy;

  before(async () => {
    await resetTestDB();
    sandbox = sinon.createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  beforeEach(() => {
    sendEmailSpy.resetHistory();
  });

  after(() => {
    sandbox.restore();
  });

  it('should send notifications for overdue platform billing expenses', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create an overdue expense
    const pastDueDate = moment().subtract(7, 'days').toDate();
    const overdueExpense = await fakeExpense({
      createdAt: pastDueDate,
      CollectiveId: collective.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.APPROVED,
      amount: 10000, // $100.00
      currency: 'USD',
      data: { bill: fakePlatformBill({ dueDate: pastDueDate }) },
    });

    // Run the cron job
    await run();

    // Verify email was sent
    await waitForCondition(() => sendEmailSpy.callCount > 0);
    expect(sendEmailSpy.callCount).to.equal(1);
    expect(sendEmailSpy.firstCall.args[0]).to.equal(admin.email);
    expect(sendEmailSpy.firstCall.args[2]).to.contain(`/${collective.slug}/expenses/${overdueExpense.id}`);

    // Verify activity was created
    const activity = await models.Activity.findOne({
      where: {
        type: ActivityTypes.PLATFORM_BILLING_OVERDUE_REMINDER,
        CollectiveId: collective.id,
      },
    });
    expect(activity).to.exist;
    expect(activity.data.expenses).to.have.length(1);
    expect(activity.data.expenses[0].id).to.equal(overdueExpense.id);
  });

  it('should not send notifications for paid expenses', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create a paid expense (should not send notification)
    const pastDueDate = moment().subtract(7, 'days').toDate();
    await fakeExpense({
      createdAt: moment().subtract(7, 'days').toDate(),
      CollectiveId: collective.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.PAID,
      amount: 10000,
      currency: 'USD',
      data: {
        bill: {
          dueDate: pastDueDate,
          totalAmount: 10000,
        },
      },
    });

    // Run the cron job
    await run();
    await sleep(50);

    // Verify no email was sent
    expect(sendEmailSpy.called).to.be.false;
  });

  it('should not send notifications for expenses that are not overdue', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create an expense due in the future
    const today = moment().toDate();
    await fakeExpense({
      CollectiveId: collective.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.APPROVED,
      amount: 10000,
      currency: 'USD',
      data: {
        bill: {
          dueDate: today,
          totalAmount: 10000,
        },
      },
    });

    // Run the cron job
    await run();
    await sleep(50);

    // Verify no email was sent
    expect(sendEmailSpy.called).to.be.false;
  });

  it('should not send duplicate notifications within a week', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create an overdue expense
    const pastDueDate = moment().subtract(7, 'days').toDate();
    await fakeExpense({
      createdAt: pastDueDate,
      CollectiveId: collective.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.APPROVED,
      amount: 10000,
      currency: 'USD',
      data: {
        bill: {
          dueDate: pastDueDate,
          totalAmount: 10000,
        },
      },
    });

    // Run the cron job
    await run();
    expect(sendEmailSpy.called).to.be.true;
    sendEmailSpy.resetHistory();

    // Run the cron job again
    await run();
    expect(sendEmailSpy.called).to.be.false;
  });

  it('should send notifications to all admins of the organization', async () => {
    // Create test data
    const admin1 = await fakeUser();
    const admin2 = await fakeUser();
    const collective = await fakeCollective({ admin: [admin1, admin2] });

    // Create an overdue expense
    const pastDueDate = moment().subtract(7, 'days').toDate();
    await fakeExpense({
      createdAt: moment().subtract(7, 'days').toDate(),
      CollectiveId: collective.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.APPROVED,
      amount: 10000,
      currency: 'USD',
      data: {
        bill: {
          dueDate: pastDueDate,
          totalAmount: 10000,
        },
      },
    });

    // Run the cron job
    await run();
    await sleep(50);

    // Verify emails were sent to both admins
    await waitForCondition(() => sendEmailSpy.callCount >= 2);
    expect(sendEmailSpy.calledTwice).to.be.true;
    const emailAddresses = [sendEmailSpy.firstCall.args[0], sendEmailSpy.secondCall.args[0]];
    expect(emailAddresses).to.include(admin1.email);
    expect(emailAddresses).to.include(admin2.email);
  });

  it('should handle multiple overdue expenses for the same organization', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create 3 overdue expenses
    const pastDueDate1 = moment('2025-08-01').toDate();
    const pastDueDate2 = moment('2025-07-01').toDate();
    const pastDueDate3 = moment('2025-06-01').toDate();

    const expense1 = await fakeExpense({
      createdAt: moment().subtract(7, 'days').toDate(),
      CollectiveId: collective.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.APPROVED,
      amount: 5000, // $50.00
      currency: 'USD',
      data: { bill: fakePlatformBill({ dueDate: pastDueDate1 }) },
    });

    const expense2 = await fakeExpense({
      createdAt: moment().subtract(7, 'days').toDate(),
      CollectiveId: collective.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.APPROVED,
      amount: 7500, // $75.00
      currency: 'USD',
      data: { bill: fakePlatformBill({ dueDate: pastDueDate2 }) },
    });

    const expense3 = await fakeExpense({
      createdAt: moment().subtract(7, 'days').toDate(),
      CollectiveId: collective.id,
      type: ExpenseType.PLATFORM_BILLING,
      status: ExpenseStatus.APPROVED,
      amount: 10000, // $100.00
      currency: 'USD',
      data: { bill: fakePlatformBill({ dueDate: pastDueDate3 }) },
    });

    // Run the cron job
    await run();

    // Verify email was sent
    await waitForCondition(() => sendEmailSpy.callCount > 0);
    expect(sendEmailSpy.callCount).to.equal(1);
    expect(sendEmailSpy.firstCall.args[0]).to.equal(admin.email);
    expect(sendEmailSpy.firstCall.args[2]).to.contain(`/dashboard/${collective.slug}/platform-subscription`); // General link
    expect(sendEmailSpy.firstCall.args[2]).to.contain(`/${collective.slug}/expenses/${expense1.id}`);
    expect(sendEmailSpy.firstCall.args[2]).to.contain(`/${collective.slug}/expenses/${expense2.id}`);
    expect(sendEmailSpy.firstCall.args[2]).to.contain(`/${collective.slug}/expenses/${expense3.id}`);
  });
});
