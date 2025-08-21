import { expect } from 'chai';
import moment from 'moment';

import { activities } from '../../../server/constants';
import ExpenseStatuses from '../../../server/constants/expense-status';
import { PlatformSubscriptionTiers } from '../../../server/constants/plans';
import { Activity, PlatformSubscription } from '../../../server/models';
import { BillingMonth, BillingPeriod, UtilizationType } from '../../../server/models/PlatformSubscription';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeEvent,
  fakeExpense,
  fakeProject,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

async function fakeExpensePaidWithActivity(data) {
  const expense = await fakeExpense(data);

  await fakeActivity({
    type: activities.COLLECTIVE_EXPENSE_PAID,
    HostCollectiveId: expense.HostCollectiveId,
    CollectiveId: expense.CollectiveId,
    ExpenseId: expense.id,
    createdAt: expense.createdAt,
  });

  return expense;
}

describe('server/models/PlatformSubscriptions', () => {
  describe('getCurrentSubscription', () => {
    it('returns null if no platform subscription for collective id', async () => {
      const collective = await fakeCollective();
      expect(PlatformSubscription.getCurrentSubscription(collective.id)).to.eventually.equal(null);
    });

    it('returns platform subscription if has overlap for collective id', async () => {
      const collective = await fakeCollective();
      const subscription = await PlatformSubscription.create({
        CollectiveId: collective.id,
        period: [
          { value: new Date(Date.UTC(2016, 0, 1)), inclusive: false },
          { value: new Date(Date.UTC(2016, 0, 2)), inclusive: true },
        ],
      });
      await expect(
        PlatformSubscription.getCurrentSubscription(collective.id, { now: () => new Date(Date.UTC(2016, 0, 1)) }),
      ).to.eventually.equal(null);

      await expect(
        PlatformSubscription.getCurrentSubscription(collective.id, { now: () => new Date(Date.UTC(2016, 0, 2)) }),
      )
        .to.eventually.property('id')
        .equal(subscription.id);
    });
  });

  describe('createSubscription', () => {
    it('throws when creating overlapping periods', async () => {
      const collective = await fakeCollective();
      await expect(
        PlatformSubscription.create({
          CollectiveId: collective.id,
          period: [
            { value: new Date(Date.UTC(2016, 0, 1)), inclusive: false },
            { value: new Date(Date.UTC(2016, 0, 6)), inclusive: true },
          ],
        }),
      ).to.be.fulfilled;

      await expect(
        PlatformSubscription.create({
          CollectiveId: collective.id,
          period: [
            { value: new Date(Date.UTC(2016, 0, 5)), inclusive: false },
            { value: new Date(Date.UTC(2016, 0, 9)), inclusive: true },
          ],
        }),
      ).to.be.rejectedWith(Error);
    });

    it('creates a subscription if not existing current subscription', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });
      const subscription = await PlatformSubscription.createSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 1, 22, 22, 3)),
        {
          title: 'A plan',
        },
        admin,
      );

      expect(subscription.start.inclusive).to.be.true;
      expect(moment.utc(subscription.start.value).toISOString()).to.equal('2016-01-01T00:00:00.000Z');

      expect(subscription.end.inclusive).to.be.true;
      expect(subscription.end.value).to.equal(Infinity);
    });

    it('throws if subscription already exists', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });
      await PlatformSubscription.createSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 1, 22, 11, 2)),
        {
          title: 'A plan',
        },
        admin,
      );

      await expect(
        PlatformSubscription.createSubscription(
          collective,
          new Date(Date.UTC(2016, 0, 2)),
          {
            title: 'A plan',
          },
          admin,
        ),
      ).to.be.rejectedWith(Error);
    });

    it('emits PLATFORM_SUBSCRIPTION_UPDATED activity', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });
      const planData = {
        title: 'Basic Plan',
        id: 'basic-5',
      };

      await PlatformSubscription.createSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 1, 22, 22, 3)),
        planData,
        admin,
      );

      // Check that activity was created
      const activity = await Activity.findOne({
        where: {
          CollectiveId: collective.id,
          type: activities.PLATFORM_SUBSCRIPTION_UPDATED,
        },
      });

      expect(activity).to.not.be.null;
      expect(activity.data).to.have.property('previousPlan');
      expect(activity.data).to.have.property('newPlan');
      expect(activity.data.previousPlan).to.be.null; // No previous plan when creating first subscription
      expect(activity.data.newPlan.title).to.equal('Basic Plan');
      expect(activity.data.newPlan.id).to.equal('basic-5');
    });
  });

  describe('replaceCurrentSubscription', () => {
    it('replaces existing period if less than a full day', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });
      const subscription = await PlatformSubscription.createSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 1, 22, 1, 22, 1)),
        {
          title: 'A plan',
        },
        admin,
      );

      expect(subscription.start.inclusive).to.be.true;
      expect(moment.utc(subscription.start.value).toISOString()).to.equal('2016-01-01T00:00:00.000Z');

      expect(subscription.end.inclusive).to.be.true;
      expect(subscription.end.value).to.equal(Infinity);

      const newSubscription = await PlatformSubscription.replaceCurrentSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 1, 10, 1, 1)),
        {
          title: 'A plan',
        },
        admin,
      );

      await subscription.reload({
        paranoid: false,
      });
      expect(subscription.deletedAt).to.not.be.null;

      expect(newSubscription.start.inclusive).to.be.true;
      expect(moment.utc(newSubscription.start.value).toISOString()).to.equal('2016-01-01T00:00:00.000Z');

      expect(newSubscription.end.inclusive).to.be.true;
      expect(newSubscription.end.value).to.equal(Infinity);
    });

    it('ends existing period and start new until end of month', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });
      const subscription = await PlatformSubscription.createSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 1, 22, 1, 22, 1)),
        {
          title: 'A plan',
        },
        admin,
      );

      expect(subscription.start.inclusive).to.be.true;
      expect(moment.utc(subscription.start.value).toISOString()).to.equal('2016-01-01T00:00:00.000Z');

      expect(subscription.end.inclusive).to.be.true;
      expect(subscription.end.value).to.equal(Infinity);

      const newSubscription = await PlatformSubscription.replaceCurrentSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 2, 22, 3)),
        {
          title: 'A plan',
        },
        admin,
      );

      await subscription.reload();
      expect(subscription.start.inclusive).to.be.true;
      expect(moment.utc(subscription.start.value).toISOString()).to.equal('2016-01-01T00:00:00.000Z');

      expect(subscription.end.inclusive).to.be.false;
      expect(moment.utc(subscription.end.value).toISOString()).to.equal('2016-01-02T00:00:00.000Z');

      expect(newSubscription.start.inclusive).to.be.true;
      expect(moment.utc(newSubscription.start.value).toISOString()).to.equal('2016-01-02T00:00:00.000Z');

      expect(newSubscription.end.inclusive).to.be.true;
      expect(newSubscription.end.value).to.equal(Infinity);
    });

    it('emits PLATFORM_SUBSCRIPTION_UPDATED activity with legacy and new plan details', async () => {
      const admin = await fakeUser();
      const collective = await fakeCollective({ admin });

      // Create initial subscription
      const initialPlan = {
        title: 'Initial Plan',
        id: 'initial-1',
      };

      await PlatformSubscription.createSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 1, 22, 1, 22, 1)),
        initialPlan,
        admin,
      );

      // Replace with new subscription
      const newPlan = {
        title: 'New Plan',
        id: 'new-5',
      };

      await PlatformSubscription.replaceCurrentSubscription(
        collective,
        new Date(Date.UTC(2016, 0, 2, 22, 3)),
        newPlan,
        admin,
      );

      // Check that activity was created
      const activity = await Activity.findOne({
        where: {
          CollectiveId: collective.id,
          type: activities.PLATFORM_SUBSCRIPTION_UPDATED,
        },
        order: [['createdAt', 'DESC']], // Get the most recent activity
      });

      expect(activity).to.not.be.null;
      expect(activity.data).to.have.property('previousPlan');
      expect(activity.data).to.have.property('newPlan');
      expect(activity.data.previousPlan).to.not.be.null;
      expect(activity.data.previousPlan.title).to.equal('Initial Plan');
      expect(activity.data.previousPlan.id).to.equal('initial-1');
      expect(activity.data.newPlan.title).to.equal('New Plan');
      expect(activity.data.newPlan.id).to.equal('new-5');
    });
  });

  describe('calculateUtilization', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('returns utilization for period', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const col = await fakeCollective({
        HostCollectiveId: host.id,
      });

      const colWithEvent = await fakeCollective({
        HostCollectiveId: host.id,
      });

      const event = await fakeEvent({
        ParentCollectiveId: colWithEvent.id,
      });

      const colWithProject = await fakeCollective({
        HostCollectiveId: host.id,
      });

      const project = await fakeProject({
        ParentCollectiveId: colWithProject.id,
      });

      const otherCol = await fakeCollective({
        HostCollectiveId: host.id,
      });

      const colActiveOutsidePeriod = await fakeCollective({
        HostCollectiveId: host.id,
      });

      const colActiveOutsidePeriod2 = await fakeCollective({
        HostCollectiveId: host.id,
      });

      await fakeTransaction({
        HostCollectiveId: host.id,
        CollectiveId: colActiveOutsidePeriod.id,
        createdAt: new Date(Date.UTC(2026, 0, 2)),
      });

      await fakeExpensePaidWithActivity({
        HostCollectiveId: host.id,
        CollectiveId: colActiveOutsidePeriod2.id,
        createdAt: new Date(Date.UTC(2026, 0, 2)),
        status: ExpenseStatuses.PAID,
      });

      await fakeCollective({
        HostCollectiveId: host.id,
      });

      await PlatformSubscription.createSubscription(
        host,
        new Date(Date.UTC(2016, 0, 1)),
        {
          title: 'A plan',
        },
        hostAdmin,
      );

      const billingPeriod: BillingPeriod = {
        year: 2016,
        month: BillingMonth.JANUARY,
      };
      await expect(PlatformSubscription.calculateUtilization(host.id, billingPeriod)).to.eventually.eql({
        [UtilizationType.ACTIVE_COLLECTIVES]: 0,
        [UtilizationType.EXPENSES_PAID]: 0,
      });

      await fakeTransaction({
        HostCollectiveId: host.id,
        CollectiveId: colWithEvent.id,
        createdAt: new Date(Date.UTC(2016, 0, 2)),
      });

      await fakeTransaction({
        HostCollectiveId: host.id,
        CollectiveId: event.id,
        createdAt: new Date(Date.UTC(2016, 0, 2)),
      });

      await fakeTransaction({
        HostCollectiveId: host.id,
        CollectiveId: colWithProject.id,
        createdAt: new Date(Date.UTC(2016, 0, 2)),
      });

      await fakeTransaction({
        HostCollectiveId: host.id,
        CollectiveId: project.id,
        createdAt: new Date(Date.UTC(2016, 0, 2)),
      });

      await fakeTransaction({
        HostCollectiveId: host.id,
        CollectiveId: col.id,
        createdAt: new Date(Date.UTC(2016, 0, 2)),
      });
      await fakeTransaction({
        HostCollectiveId: host.id,
        CollectiveId: col.id,
        createdAt: new Date(Date.UTC(2016, 0, 20)),
      });

      await expect(PlatformSubscription.calculateUtilization(host.id, billingPeriod)).to.eventually.eql({
        [UtilizationType.ACTIVE_COLLECTIVES]: 3,
        [UtilizationType.EXPENSES_PAID]: 0,
      });

      await fakeExpensePaidWithActivity({
        HostCollectiveId: host.id,
        CollectiveId: otherCol.id,
        createdAt: new Date(Date.UTC(2016, 0, 20)),
        status: ExpenseStatuses.PAID,
      });

      await expect(PlatformSubscription.calculateUtilization(host.id, billingPeriod)).to.eventually.eql({
        [UtilizationType.ACTIVE_COLLECTIVES]: 3,
        [UtilizationType.EXPENSES_PAID]: 1,
      });

      await fakeExpensePaidWithActivity({
        HostCollectiveId: host.id,
        CollectiveId: col.id,
        createdAt: new Date(Date.UTC(2016, 0, 30)),
        status: ExpenseStatuses.PAID,
      });

      await fakeTransaction({
        HostCollectiveId: host.id,
        CollectiveId: otherCol.id,
        createdAt: new Date(Date.UTC(2016, 0, 20)),
      });

      await fakeExpensePaidWithActivity({
        HostCollectiveId: host.id,
        CollectiveId: otherCol.id,
        createdAt: new Date(Date.UTC(2016, 0, 30)),
        status: ExpenseStatuses.PAID,
      });

      // will not count
      const rePaidInThisBillingPeriod = await fakeExpense({
        HostCollectiveId: host.id,
        CollectiveId: otherCol.id,
        createdAt: new Date(Date.UTC(2015, 0, 30)),
      });

      await fakeActivity({
        type: activities.COLLECTIVE_EXPENSE_PAID,
        HostCollectiveId: rePaidInThisBillingPeriod.HostCollectiveId,
        CollectiveId: rePaidInThisBillingPeriod.CollectiveId,
        ExpenseId: rePaidInThisBillingPeriod.id,
        createdAt: new Date(Date.UTC(2015, 0, 30)),
      });

      // paid again, will not count
      await fakeActivity({
        type: activities.COLLECTIVE_EXPENSE_PAID,
        HostCollectiveId: rePaidInThisBillingPeriod.HostCollectiveId,
        CollectiveId: rePaidInThisBillingPeriod.CollectiveId,
        ExpenseId: rePaidInThisBillingPeriod.id,
        createdAt: new Date(Date.UTC(2016, 0, 30)),
      });

      await expect(PlatformSubscription.calculateUtilization(host.id, billingPeriod)).to.eventually.eql({
        [UtilizationType.ACTIVE_COLLECTIVES]: 4,
        [UtilizationType.EXPENSES_PAID]: 3,
      });
    });
  });

  describe('billing', () => {
    beforeEach(async () => {
      await resetTestDB();
    });

    it('returns active subscriptions during billing period', async () => {
      const billingPeriod = {
        year: 2016,
        month: BillingMonth.JANUARY,
      };

      const admin = await fakeUser();
      const collective1 = await fakeCollective({ admin }); // two subscriptions were active in billing period
      const collective1Sub1 = await PlatformSubscription.createSubscription(
        collective1,
        new Date(Date.UTC(2016, 0, 1)),
        {
          title: 'A plan',
        },
        admin,
      );
      const collective1Sub2 = await PlatformSubscription.replaceCurrentSubscription(
        collective1,
        new Date(Date.UTC(2016, 0, 5)),
        {
          title: 'A plan',
        },
        admin,
      );

      const collective1Subs = await PlatformSubscription.getSubscriptionsInBillingPeriod(collective1.id, billingPeriod);
      expect(collective1Subs[0].id).to.eql(collective1Sub2.id);
      expect(collective1Subs[1].id).to.eql(collective1Sub1.id);

      const collective2 = await fakeCollective({ admin }); // no active subscription in billing period
      await expect(
        PlatformSubscription.getSubscriptionsInBillingPeriod(collective2.id, billingPeriod),
      ).to.eventually.have.length(0);

      const collective3 = await fakeCollective({ admin }); // one active subscription in billing period
      const collective3Sub1 = await PlatformSubscription.createSubscription(
        collective3,
        new Date(Date.UTC(2016, 0, 1)),
        {
          title: 'A plan',
        },
        admin,
      );
      const collective3Subs = await PlatformSubscription.getSubscriptionsInBillingPeriod(collective3.id, billingPeriod);
      expect(collective3Subs[0].id).to.eql(collective3Sub1.id);
    });

    it('calculates utilization and charges for billing period with two subs', async () => {
      const billingPeriod = {
        year: 2016,
        month: BillingMonth.JANUARY,
      };

      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      await PlatformSubscription.createSubscription(
        host,
        new Date(Date.UTC(2016, 0, 1)),
        PlatformSubscriptionTiers.find(plan => plan.id === 'basic-5'),
        admin,
      );

      // create 10 active collectives
      for (let i = 0; i < 10; i++) {
        const col = await fakeCollective({ HostCollectiveId: host.id });
        await fakeTransaction({
          HostCollectiveId: host.id,
          CollectiveId: col.id,
          createdAt: new Date(Date.UTC(2016, 0, 20)),
        });
      }

      const col = await fakeCollective({ HostCollectiveId: host.id });
      // 60 paid expenses
      for (let i = 0; i < 60; i++) {
        await fakeExpensePaidWithActivity({
          HostCollectiveId: host.id,
          CollectiveId: col.id,
          createdAt: new Date(Date.UTC(2016, 0, 2)),
          status: ExpenseStatuses.PAID,
        });
      }

      let billing = await PlatformSubscription.calculateBilling(host.id, billingPeriod);
      expect(billing).to.containSubset({
        additional: {
          amounts: {
            activeCollectives: 7500,
            expensesPaid: 1500,
          },
          utilization: {
            activeCollectives: 5,
            expensesPaid: 10,
          },
          total: 9000,
        },
        utilization: {
          activeCollectives: 10,
          expensesPaid: 60,
        },
        baseAmount: 5000,
        totalAmount: 14000,
      });

      await PlatformSubscription.replaceCurrentSubscription(
        host,
        new Date(Date.UTC(2016, 0, 15)),
        PlatformSubscriptionTiers.find(plan => plan.id === 'pro-20'),
        admin,
      );

      billing = await PlatformSubscription.calculateBilling(host.id, billingPeriod);
      expect(billing).to.containSubset({
        additional: {
          amounts: {
            activeCollectives: 0,
            expensesPaid: 0,
          },
          utilization: {
            activeCollectives: 0,
            expensesPaid: 0,
          },
          total: 0,
        },
        utilization: {
          activeCollectives: 10,
          expensesPaid: 60,
        },
        baseAmount: 21452,
        totalAmount: 21452,
      });
    });

    it('calculates utilization and charges for billing period with partial sub', async () => {
      const billingPeriod = {
        year: 2016,
        month: BillingMonth.JANUARY,
      };

      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      await PlatformSubscription.createSubscription(
        host,
        new Date(Date.UTC(2016, 0, 15)),
        PlatformSubscriptionTiers.find(plan => plan.id === 'basic-5'),
        hostAdmin,
      );

      // create 10 active collectives
      for (let i = 0; i < 10; i++) {
        const col = await fakeCollective({ HostCollectiveId: host.id });
        await fakeTransaction({
          HostCollectiveId: host.id,
          CollectiveId: col.id,
          createdAt: new Date(Date.UTC(2016, 0, 20)),
        });
      }

      const col = await fakeCollective({ HostCollectiveId: host.id });
      // 60 paid expenses
      for (let i = 0; i < 60; i++) {
        await fakeExpensePaidWithActivity({
          HostCollectiveId: host.id,
          CollectiveId: col.id,
          createdAt: new Date(Date.UTC(2016, 0, 2)),
          status: ExpenseStatuses.PAID,
        });
      }

      const billing = await PlatformSubscription.calculateBilling(host.id, billingPeriod);
      expect(billing).to.containSubset({
        additional: {
          amounts: {
            activeCollectives: 7500,
            expensesPaid: 1500,
          },
          utilization: {
            activeCollectives: 5,
            expensesPaid: 10,
          },
          total: 9000,
        },
        utilization: {
          activeCollectives: 10,
          expensesPaid: 60,
        },
        baseAmount: 2742,
        totalAmount: 11742,
      });
    });

    it('calculates utilization and charges for billing period with ended sub', async () => {
      const billingPeriod = {
        year: 2016,
        month: BillingMonth.JANUARY,
      };

      const hostAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: hostAdmin });
      const sub = await PlatformSubscription.createSubscription(
        host,
        new Date(Date.UTC(2016, 0, 1)),
        PlatformSubscriptionTiers.find(plan => plan.id === 'basic-5'),
        hostAdmin,
      );

      // create 10 active collectives
      for (let i = 0; i < 10; i++) {
        const col = await fakeCollective({ HostCollectiveId: host.id });
        await fakeTransaction({
          HostCollectiveId: host.id,
          CollectiveId: col.id,
          createdAt: new Date(Date.UTC(2016, 0, 20)),
        });
      }

      const col = await fakeCollective({ HostCollectiveId: host.id });
      // 60 paid expenses
      for (let i = 0; i < 60; i++) {
        await fakeExpensePaidWithActivity({
          HostCollectiveId: host.id,
          CollectiveId: col.id,
          createdAt: new Date(Date.UTC(2016, 0, 2)),
          status: ExpenseStatuses.PAID,
        });
      }

      await sub.update({
        period: [
          sub.start,
          {
            value: new Date(Date.UTC(2016, 0, 15)),
            inclusive: false,
          },
        ],
      });

      const billing = await PlatformSubscription.calculateBilling(host.id, billingPeriod);
      expect(billing).to.containSubset({
        additional: {
          amounts: {
            activeCollectives: 7500,
            expensesPaid: 1500,
          },
          utilization: {
            activeCollectives: 5,
            expensesPaid: 10,
          },
          total: 9000,
        },
        utilization: {
          activeCollectives: 10,
          expensesPaid: 60,
        },
        baseAmount: 2258,
        totalAmount: 11258,
      });
    });
  });
});
