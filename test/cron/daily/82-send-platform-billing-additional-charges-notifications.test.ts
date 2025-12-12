import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import { run } from '../../../cron/daily/82-send-platform-billing-additional-charges-notifications';
import ActivityTypes from '../../../server/constants/activities';
import emailLib from '../../../server/lib/email';
import { sleep } from '../../../server/lib/utils';
import models from '../../../server/models';
import PlatformSubscription from '../../../server/models/PlatformSubscription';
import { fakeCollective, fakePlatformSubscription, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB, waitForCondition } from '../../utils';

describe('cron/daily/send-platform-billing-additional-charges-notifications', () => {
  let sandbox;
  let sendEmailSpy;

  before(async () => {
    await resetTestDB();
  });

  beforeEach(async () => {
    // Clean up any existing activities and platform subscriptions to ensure test isolation
    await models.Activity.destroy({ where: { type: ActivityTypes.PLATFORM_BILLING_ADDITIONAL_CHARGES_NOTIFICATION } });
    await models.PlatformSubscription.destroy({ where: {} });
    sandbox = sinon.createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should send notifications for first-time additional charges', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create a platform subscription
    await fakePlatformSubscription({
      CollectiveId: collective.id,
      plan: {
        title: 'Standard Plan',
        pricing: {
          pricePerMonth: 10000, // $100.00 base
          includedCollectives: 5,
          includedExpensesPerMonth: 10,
          pricePerAdditionalCollective: 600, // $6.00 per additional collective
          pricePerAdditionalExpense: 200, // $2.00 per additional expense
        },
      },
    });

    // Stub calculateBilling to return additional charges
    sandbox.stub(PlatformSubscription, 'calculateBilling').resolves({
      collectiveId: collective.id,
      base: {
        total: 10000, // $100.00 base
        subscriptions: [
          {
            title: 'Standard Plan',
            amount: 10000,
            startDate: moment().subtract(1, 'month').toDate(),
            endDate: moment().toDate(),
          },
        ],
      },
      additional: {
        total: 5000, // $50.00 additional charges
        utilization: {
          activeCollectives: 5, // 5 over the limit
          expensesPaid: 10, // 10 over the limit
        },
        amounts: {
          activeCollectives: 3000, // $30.00 (5 * $6.00)
          expensesPaid: 2000, // $20.00 (10 * $2.00)
        },
      },
      totalAmount: 15000,
      billingPeriod: PlatformSubscription.currentBillingPeriod(),
      subscriptions: [
        {
          plan: {
            title: 'Standard Plan',
            pricing: {
              pricePerMonth: 10000,
              includedCollectives: 5,
              includedExpensesPerMonth: 10,
              pricePerAdditionalCollective: 600,
              pricePerAdditionalExpense: 200,
            },
          },
        },
      ],
      utilization: {
        activeCollectives: 10, // Total usage
        expensesPaid: 20, // Total usage
      },
      dueDate: moment().add(1, 'month').startOf('month').toDate(),
    });

    // Run the cron job
    await run();

    // Verify email was sent
    await waitForCondition(() => sendEmailSpy.callCount > 0);
    expect(sendEmailSpy.callCount).to.equal(1);
    expect(sendEmailSpy.firstCall.args[0]).to.equal(admin.email);
    expect(sendEmailSpy.firstCall.args[1]).to.contain(
      'Additional charges notice for your Open Collective platform subscription',
    );

    // Verify activity was created
    const activity = await models.Activity.findOne({
      where: {
        type: ActivityTypes.PLATFORM_BILLING_ADDITIONAL_CHARGES_NOTIFICATION,
        CollectiveId: collective.id,
      },
    });
    expect(activity).to.exist;
    expect(activity.data.collective.id).to.equal(collective.id);
    expect(activity.data.subscription).to.exist; // Verify subscription is included
    expect(activity.data.currentUtilization.activeCollectives).to.equal(10);
    expect(activity.data.currentUtilization.expensesPaid).to.equal(20);
    expect(activity.data.subscription.plan.pricing.pricePerAdditionalCollective).to.equal(600);
    expect(activity.data.subscription.plan.pricing.pricePerAdditionalExpense).to.equal(200);
  });

  it('should not send notifications for subscriptions without additional charges', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create a platform subscription
    await fakePlatformSubscription({
      CollectiveId: collective.id,
      plan: {
        title: 'Standard Plan',
        pricing: {
          pricePerMonth: 10000, // $100.00 base
          includedCollectives: 10,
          includedExpensesPerMonth: 20,
          pricePerAdditionalCollective: 600,
          pricePerAdditionalExpense: 200,
        },
      },
    });

    // Stub calculateBilling to return NO additional charges
    sandbox.stub(PlatformSubscription, 'calculateBilling').resolves({
      collectiveId: collective.id,
      base: {
        total: 10000,
        subscriptions: [
          {
            title: 'Standard Plan',
            amount: 10000,
            startDate: moment().subtract(1, 'month').toDate(),
            endDate: moment().toDate(),
          },
        ],
      },
      additional: {
        total: 0, // NO additional charges
        utilization: {
          activeCollectives: 0,
          expensesPaid: 0,
        },
        amounts: {
          activeCollectives: 0,
          expensesPaid: 0,
        },
      },
      totalAmount: 10000,
      billingPeriod: PlatformSubscription.currentBillingPeriod(),
      subscriptions: [
        {
          plan: {
            title: 'Standard Plan',
            pricing: {
              pricePerMonth: 10000,
              includedCollectives: 10,
              includedExpensesPerMonth: 20,
              pricePerAdditionalCollective: 600,
              pricePerAdditionalExpense: 200,
            },
          },
        },
      ],
      utilization: {
        activeCollectives: 5, // Within limits
        expensesPaid: 15, // Within limits
      },
      dueDate: moment().add(1, 'month').startOf('month').toDate(),
    });

    // Run the cron job
    await run();
    await sleep(50);

    // Verify no email was sent
    expect(sendEmailSpy.called).to.be.false;
  });

  it('should not send duplicate notifications to organizations that have been notified before', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create a platform subscription with additional charges
    await fakePlatformSubscription({
      CollectiveId: collective.id,
      plan: {
        title: 'Standard Plan',
        pricing: {
          pricePerMonth: 10000,
          includedCollectives: 5,
          includedExpensesPerMonth: 10,
          pricePerAdditionalCollective: 600,
          pricePerAdditionalExpense: 200,
        },
      },
    });

    // Stub calculateBilling to return additional charges
    sandbox.stub(PlatformSubscription, 'calculateBilling').resolves({
      collectiveId: collective.id,
      additional: {
        total: 5000,
        utilization: {
          activeCollectives: 5,
          expensesPaid: 0,
        },
        amounts: {
          activeCollectives: 5000,
          expensesPaid: 0,
        },
      },
      base: { total: 10000, subscriptions: [] },
      totalAmount: 15000,
      billingPeriod: PlatformSubscription.currentBillingPeriod(),
      subscriptions: [{ plan: { title: 'Standard Plan' } }],
      utilization: { activeCollectives: 10, expensesPaid: 10 },
      dueDate: moment().add(1, 'month').startOf('month').toDate(),
    });

    // Run the cron job
    await run();
    await sleep(50);
    expect(sendEmailSpy.called).to.be.true;
    sendEmailSpy.resetHistory();

    // Re-run the cron job
    await run();
    await sleep(50);
    expect(sendEmailSpy.called, `Expected no emails to be sent but ${sendEmailSpy.callCount} were sent`).to.be.false;
  });

  it('should handle subscriptions with only active collectives additional charges', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create a platform subscription
    await fakePlatformSubscription({
      CollectiveId: collective.id,
      plan: {
        title: 'Standard Plan',
        pricing: {
          pricePerMonth: 10000,
          includedCollectives: 5,
          includedExpensesPerMonth: 20,
          pricePerAdditionalCollective: 300, // $3.00 per additional collective
          pricePerAdditionalExpense: 200,
        },
      },
    });

    // Stub calculateBilling to return only active collectives additional charges
    sandbox.stub(PlatformSubscription, 'calculateBilling').resolves({
      collectiveId: collective.id,
      additional: {
        total: 3000, // $30.00 additional charges
        utilization: {
          activeCollectives: 10, // 10 over the limit, only active collectives charges
          expensesPaid: 0, // No expenses paid charges
        },
        amounts: {
          activeCollectives: 3000, // $30.00 (10 * $3.00)
          expensesPaid: 0,
        },
      },
      base: { total: 10000, subscriptions: [] },
      totalAmount: 13000,
      billingPeriod: PlatformSubscription.currentBillingPeriod(),
      subscriptions: [{ plan: { title: 'Standard Plan' } }],
      utilization: { activeCollectives: 15, expensesPaid: 10 },
      dueDate: moment().add(1, 'month').startOf('month').toDate(),
    });

    // Run the cron job
    await run();

    // Verify email was sent
    await waitForCondition(() => sendEmailSpy.callCount > 0);
    expect(sendEmailSpy.callCount).to.equal(1);
    expect(sendEmailSpy.firstCall.args[1]).to.contain(
      'Additional charges notice for your Open Collective platform subscription',
    );
  });

  it('should handle subscriptions with only paid expenses additional charges', async () => {
    // Create test data
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });

    // Create a platform subscription
    await fakePlatformSubscription({
      CollectiveId: collective.id,
      plan: {
        title: 'Standard Plan',
        pricing: {
          pricePerMonth: 10000,
          includedCollectives: 20,
          includedExpensesPerMonth: 10,
          pricePerAdditionalCollective: 300,
          pricePerAdditionalExpense: 100, // $1.00 per additional expense
        },
      },
    });

    // Stub calculateBilling to return only paid expenses additional charges
    sandbox.stub(PlatformSubscription, 'calculateBilling').resolves({
      collectiveId: collective.id,
      additional: {
        total: 2500, // $25.00 additional charges
        utilization: {
          activeCollectives: 0, // No active collectives charges
          expensesPaid: 25, // 25 over the limit, only expenses paid charges
        },
        amounts: {
          activeCollectives: 0,
          expensesPaid: 2500, // $25.00 (25 * $1.00)
        },
      },
      base: { total: 10000, subscriptions: [] },
      totalAmount: 12500,
      billingPeriod: PlatformSubscription.currentBillingPeriod(),
      subscriptions: [{ plan: { title: 'Standard Plan' } }],
      utilization: { activeCollectives: 15, expensesPaid: 35 },
      dueDate: moment().add(1, 'month').startOf('month').toDate(),
    });

    // Run the cron job
    await run();

    // Verify email was sent
    await waitForCondition(() => sendEmailSpy.callCount > 0);
    expect(sendEmailSpy.callCount).to.equal(1);
    expect(sendEmailSpy.firstCall.args[1]).to.contain(
      'Additional charges notice for your Open Collective platform subscription',
    );
  });

  it('should handle multiple organizations with subscriptions correctly', async () => {
    const admin = await fakeUser();
    const collective1 = await fakeCollective({ admin });
    const collective2 = await fakeCollective({ admin });
    const collective3 = await fakeCollective({ admin });

    // Create platform subscriptions for all three
    await fakePlatformSubscription({
      CollectiveId: collective1.id,
      plan: {
        title: 'Plan 1',
        pricing: {
          pricePerMonth: 10000,
          includedCollectives: 5,
          includedExpensesPerMonth: 10,
          pricePerAdditionalCollective: 600,
          pricePerAdditionalExpense: 200,
        },
      },
    });
    await fakePlatformSubscription({
      CollectiveId: collective2.id,
      plan: {
        title: 'Plan 2',
        pricing: {
          pricePerMonth: 10000,
          includedCollectives: 5,
          includedExpensesPerMonth: 10,
          pricePerAdditionalCollective: 600,
          pricePerAdditionalExpense: 200,
        },
      },
    });
    await fakePlatformSubscription({
      CollectiveId: collective3.id,
      plan: {
        title: 'Plan 3',
        pricing: {
          pricePerMonth: 10000,
          includedCollectives: 5,
          includedExpensesPerMonth: 10,
          pricePerAdditionalCollective: 600,
          pricePerAdditionalExpense: 200,
        },
      },
    });

    // Stub calculateBilling to return different scenarios
    const calculateBillingStub = sandbox.stub(PlatformSubscription, 'calculateBilling');

    // First collective: has additional charges
    calculateBillingStub.withArgs(collective1.id).resolves({
      collectiveId: collective1.id,
      additional: { total: 5000, utilization: { activeCollectives: 10, expensesPaid: 10 }, amounts: {} },
      base: { total: 10000, subscriptions: [] },
      totalAmount: 15000,
      billingPeriod: PlatformSubscription.currentBillingPeriod(),
      subscriptions: [{ plan: { title: 'Plan 1' } }],
      utilization: { activeCollectives: 10, expensesPaid: 10 },
      dueDate: moment().add(1, 'month').startOf('month').toDate(),
    });

    // Second collective: has additional charges
    calculateBillingStub.withArgs(collective2.id).resolves({
      collectiveId: collective2.id,
      additional: { total: 3000, utilization: { activeCollectives: 10, expensesPaid: 10 }, amounts: {} },
      base: { total: 10000, subscriptions: [] },
      totalAmount: 13000,
      billingPeriod: PlatformSubscription.currentBillingPeriod(),
      subscriptions: [{ plan: { title: 'Plan 2' } }],
      utilization: { activeCollectives: 10, expensesPaid: 10 },
      dueDate: moment().add(1, 'month').startOf('month').toDate(),
    });

    // Third collective: no additional charges
    calculateBillingStub.withArgs(collective3.id).resolves({
      collectiveId: collective3.id,
      additional: { total: 0, utilization: { activeCollectives: 10, expensesPaid: 10 }, amounts: {} },
      base: { total: 10000, subscriptions: [] },
      totalAmount: 10000,
      billingPeriod: PlatformSubscription.currentBillingPeriod(),
      subscriptions: [{ plan: { title: 'Plan 3' } }],
      utilization: { activeCollectives: 10, expensesPaid: 10 },
      dueDate: moment().add(1, 'month').startOf('month').toDate(),
    });

    // Run the cron job
    await run();

    // Verify emails were sent only for collectives with additional charges
    await waitForCondition(() => sendEmailSpy.callCount >= 2);
    expect(sendEmailSpy.callCount).to.equal(2);
  });
});
