import { expect } from 'chai';
import { pick } from 'lodash';
import moment from 'moment';
import sinon from 'sinon';

import { run } from '../../../cron/monthly/submit-platform-subscription-bills';
import { expenseTypes, roles } from '../../../server/constants';
import ActivityTypes from '../../../server/constants/activities';
import { CollectiveType } from '../../../server/constants/collectives';
import { PlatformSubscriptionTiers } from '../../../server/constants/plans';
import PlatformConstants from '../../../server/constants/platform';
import emailLib from '../../../server/lib/email';
import models, { PlatformSubscription } from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakePayoutMethod,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import { resetTestDB, waitForCondition } from '../../utils';

describe('submit-platform-subscription-bills', () => {
  const date = moment.utc('2023-10-09T10:00:00Z');
  let organizations, sandbox, emailSendMessageSpy;

  before(async () => {
    sandbox = sinon.createSandbox();
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    await resetTestDB();
    const user = await fakeUser({ id: PlatformConstants.PlatformUserId }, { slug: 'ofitech-admin' });
    const oc = await fakeHost({
      id: PlatformConstants.PlatformCollectiveId,
      slug: randStr('platform-'),
      CreatedByUserId: user.id,
    });
    await fakeConnectedAccount({ CollectiveId: oc.id, service: 'stripe' });
    const payoutProto = {
      data: {
        details: {},
        type: 'IBAN',
        accountHolderName: 'OpenCollective Inc.',
        currency: 'USD',
      },
      CollectiveId: oc.id,
      type: PayoutMethodTypes.BANK_ACCOUNT,
    };
    await fakePayoutMethod({
      ...payoutProto,
      id: 2955,
      isSaved: true,
    });

    // ocStripePayoutMethod = (await oc.getPayoutMethods()).find(pm => pm.type === PayoutMethodTypes.STRIPE);
    organizations = [];
    for (let i = 0; i < 5; i++) {
      organizations.push(await fakeCollective({ type: CollectiveType.ORGANIZATION, isActive: true }));
    }

    const plans = [
      PlatformSubscriptionTiers[0],
      PlatformSubscriptionTiers[1],
      PlatformSubscriptionTiers[2],
      PlatformSubscriptionTiers[3],
      PlatformSubscriptionTiers[4],
    ];

    const orgAdmin = await fakeUser();
    for (const org of organizations) {
      const i = organizations.indexOf(org);
      await PlatformSubscription.createSubscription(org, moment(date).subtract(2, 'month').toDate(), plans[i], user);
      await org.addUserWithRole(orgAdmin, roles.ADMIN);
    }

    const calculateUtilizationStub = sandbox.stub(PlatformSubscription, 'calculateUtilization');
    const utilizations = [
      { activeCollectives: 0, expensesPaid: 5 },
      { activeCollectives: 5, expensesPaid: 2 },
      { activeCollectives: 4, expensesPaid: 100 },
      { activeCollectives: 20, expensesPaid: 120 },
      { activeCollectives: 30, expensesPaid: 230 },
    ];
    organizations.forEach((org, i) => {
      calculateUtilizationStub.withArgs(org.id).resolves(utilizations[i]);
    });
  });

  after(() => {
    sandbox.restore();
  });

  it('should run without errors', async () => {
    await run(date);
  });

  it('should omit bills for $0', async () => {
    const expenses = await models.Expense.findAll({
      where: { CollectiveId: organizations[0].id, type: expenseTypes.PLATFORM_BILLING },
    });

    expect(expenses).to.have.length(0);
  });

  it('should submit Expenses for active subscriptions', async () => {
    const expenses = await models.Expense.findAll({
      where: { type: expenseTypes.PLATFORM_BILLING },
      order: [['id', 'DESC']],
    });

    expect(expenses).to.have.length(4);
    const expensesTable = expenses.map(e =>
      pick(e.toJSON(), ['id', 'type', 'CollectiveId', 'description', 'amount', 'currency']),
    );
    expect(expensesTable).to.matchTableSnapshot();

    const items = await models.ExpenseItem.findAll({
      where: { ExpenseId: expenses.map(e => e.id) },
      order: [['id', 'DESC']],
    });

    const itemsTable = items.map(i => pick(i.toJSON(), ['ExpenseId', 'description', 'amount', 'currency']));
    expect(itemsTable).to.matchTableSnapshot();
  });

  it('should not bill organizations twice', async () => {
    await run(date);

    const expenses = await models.Expense.findAll({
      where: { CollectiveId: organizations[1].id, type: expenseTypes.PLATFORM_BILLING },
    });

    expect(expenses).to.have.length(1);
  });

  it('should create COLLECTIVE_EXPENSE_CREATED activities', async () => {
    const activities = await models.Activity.findAll({
      where: { type: ActivityTypes.COLLECTIVE_EXPENSE_CREATED },
    });

    expect(activities).to.have.length(4);
    const org2Activity = activities.find(a => a.CollectiveId === organizations[2].id);
    expect(org2Activity.data).to.containSubset({
      expense: { type: expenseTypes.PLATFORM_BILLING, CollectiveId: organizations[2].id, amount: 8000 },
      items: [
        {
          amount: 8000,
          currency: 'USD',
          description: 'Base subscription Discover 10 - 01-Sep-2023 to 30-Sep-2023',
          incurredAt: '2023-09-30T23:59:59.999Z',
        },
      ],
      payoutMethod: { type: 'STRIPE' },
    });

    expect(org2Activity.data.bill).to.containSubset({
      base: {
        subscriptions: [{ amount: 8000, title: 'Discover 10' }],
        total: 8000,
      },
      additional: {
        total: 0,
        amounts: { activeCollectives: 0, expensesPaid: 0 },
        utilization: { activeCollectives: 0, expensesPaid: 0 },
      },
      billingPeriod: { month: 8, year: 2023 },
      dueDate: '2023-10-01T00:00:00.000Z',
      subscriptions: [
        {
          period: [{ inclusive: true, value: '2023-08-09T00:00:00.000Z' }, { inclusive: true }],
          plan: {
            id: 'discover-10',
            pricing: {
              includedCollectives: 10,
              includedExpensesPerMonth: 100,
              pricePerAdditionalCollective: 1000,
              pricePerAdditionalExpense: 100,
              pricePerMonth: 8000,
            },
            title: 'Discover 10',
            type: 'Discover',
          },
        },
      ],
      totalAmount: 8000,
      utilization: {
        activeCollectives: 4,
        expensesPaid: 100,
      },
    });
  });

  it('paying the expense sends a confirmation email', async () => {
    emailSendMessageSpy.resetHistory();
    const expense = await models.Expense.findOne({
      where: { CollectiveId: organizations[2].id, type: expenseTypes.PLATFORM_BILLING },
    });

    await expense.markAsPaid();

    await waitForCondition(() => emailSendMessageSpy.callCount > 0);
    expect(emailSendMessageSpy.callCount).to.equal(1);

    const org2Body = emailSendMessageSpy.args[0][2];
    expect(org2Body).to.contain('Your Open Collective platform subscription has been processed successfully.');
    expect(org2Body).to.contain('Billing Period');
    expect(org2Body).to.contain('8/2023');
    expect(org2Body).to.contain('$80.00');
  });
});
