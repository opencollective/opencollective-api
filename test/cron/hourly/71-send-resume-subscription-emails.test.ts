import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import { run as runCronJob } from '../../../cron/hourly/71-send-resume-subscription-emails';
import OrderStatuses from '../../../server/constants/order-status';
import emailLib from '../../../server/lib/email';
import { fakeCollective, fakeOrder, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('cron/hourly/71-send-resume-subscription-emails', () => {
  let sandbox, contributor, emailSendMessageSpy, collective, clock;

  before(async () => {
    await resetTestDB();
    sandbox = sinon.createSandbox();
    collective = await fakeCollective({
      data: {
        resumeContributionsStartedAt: new Date(),
        resumeContributionsMessage: `We're <strong>back</strong>! Thanks for going through this with us.<br /><br />
        We have now switched to OC Europe, a Brussels-based non-profit organization, as our fiscal sponsor.
        They will offer the same services we benefited from before, but with a more solid legal structure.
        We hope to have a long and fruitful collaboration with them.
      `,
      },
    });

    // Add some random orders
    await fakeOrder({ status: OrderStatuses.ACTIVE, CollectiveId: collective.id }, { withSubscription: true });
    await fakeOrder({ status: OrderStatuses.PAID, CollectiveId: collective.id }, { withSubscription: true });
    await fakeOrder({ status: OrderStatuses.CANCELLED, CollectiveId: collective.id }, { withSubscription: true });

    // Add some paused orders
    contributor = await fakeUser();
    await fakeOrder(
      { status: OrderStatuses.PAUSED, FromCollectiveId: contributor.CollectiveId, CollectiveId: collective.id },
      { withSubscription: true },
    );
  });

  beforeEach(() => {
    // Spies
    emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
  });

  afterEach(() => {
    sandbox.restore();
    if (clock) {
      clock.restore();
      clock = null;
    }
  });

  describe('if collective is inactive', () => {
    before(() => collective.update({ isActive: false }));

    it('ignores orders', async () => {
      const updatedOrders = await runCronJob();
      expect(updatedOrders).to.have.length(0);
    });
  });

  describe('if collective is active', () => {
    before(() => collective.update({ isActive: true }));

    it('sends emails for paused subscriptions', async () => {
      // Initial email
      let updatedOrders = await runCronJob();
      expect(updatedOrders).to.have.length(1);
      expect(updatedOrders[0].status).to.equal(OrderStatuses.PAUSED);
      expect(updatedOrders[0].data.resumeContribution.reminder).to.equal(1);
      let nextReminderDate = updatedOrders[0].data.resumeContribution.nextReminderDate;
      expect(nextReminderDate).to.be.a('Date');
      expect(moment().isBefore(moment(nextReminderDate))).to.be.true;
      expect(Math.round(moment(nextReminderDate).diff(moment(), 'hours') / 24)).to.equal(5);
      expect(emailSendMessageSpy.callCount).to.equal(1);
      expect(emailSendMessageSpy.firstCall.args[0]).to.equal(contributor.email);
      expect(emailSendMessageSpy.firstCall.args[1]).to.match(/Your contribution to .* is ready to be resumed/);
      expect(emailSendMessageSpy.firstCall.args[2]).to.contain(`Here is the message from ${collective.name}:`);
      expect(emailSendMessageSpy.firstCall.args[2]).to.contain(`We're <strong>back</strong>!`);
      expect(emailSendMessageSpy.firstCall.args[2]).to.contain(
        `/dashboard/${contributor.collective.slug}/outgoing-contributions`,
      );
      expect(emailSendMessageSpy.firstCall.args[2]).to.contain(
        `We will send you 3 more reminders in case you forget to resume your contribution.`,
      );

      // 1st reminder
      clock = sandbox.useFakeTimers({ now: moment(nextReminderDate).add(1, 'day').toDate(), shouldAdvanceTime: true });
      updatedOrders = await runCronJob();
      expect(updatedOrders).to.have.length(1);
      expect(updatedOrders[0].status).to.equal(OrderStatuses.PAUSED);
      expect(updatedOrders[0].data.resumeContribution.reminder).to.equal(2);
      nextReminderDate = updatedOrders[0].data.resumeContribution.nextReminderDate;
      expect(nextReminderDate).to.be.a('Date');
      expect(moment().isBefore(moment(nextReminderDate))).to.be.true;
      expect(Math.round(moment(nextReminderDate).diff(moment(), 'hours') / 24)).to.equal(12);
      expect(emailSendMessageSpy.callCount).to.equal(2);
      expect(emailSendMessageSpy.secondCall.args[0]).to.equal(contributor.email);
      expect(emailSendMessageSpy.secondCall.args[1]).to.match(
        /Reminder: Your contribution to .* is ready to be resumed/,
      );
      expect(emailSendMessageSpy.secondCall.args[2]).to.contain(
        `/dashboard/${contributor.collective.slug}/outgoing-contributions`,
      );
      expect(emailSendMessageSpy.secondCall.args[2]).to.contain(
        `We will send you 2 more reminders in case you forget to resume your contribution.`,
      );

      // 2nd reminder
      clock.restore();
      clock = sandbox.useFakeTimers({ now: moment(nextReminderDate).add(1, 'day').toDate(), shouldAdvanceTime: true });
      updatedOrders = await runCronJob();
      expect(updatedOrders).to.have.length(1);
      expect(updatedOrders[0].status).to.equal(OrderStatuses.PAUSED);
      expect(updatedOrders[0].data.resumeContribution.reminder).to.equal(3);
      nextReminderDate = updatedOrders[0].data.resumeContribution.nextReminderDate;
      expect(nextReminderDate).to.be.a('Date');
      expect(moment().isBefore(moment(nextReminderDate))).to.be.true;
      expect(Math.round(moment(nextReminderDate).diff(moment(), 'hours') / 24)).to.equal(19);
      expect(emailSendMessageSpy.callCount).to.equal(3);
      expect(emailSendMessageSpy.thirdCall.args[0]).to.equal(contributor.email);
      expect(emailSendMessageSpy.thirdCall.args[1]).to.match(
        /Reminder: Your contribution to .* is ready to be resumed/,
      );
      expect(emailSendMessageSpy.thirdCall.args[2]).to.contain(
        `/dashboard/${contributor.collective.slug}/outgoing-contributions`,
      );
      expect(emailSendMessageSpy.thirdCall.args[2]).to.contain(
        `We will send you one final reminder in case you forget to resume your contribution.`,
      );

      // 3rd and final reminder
      clock.restore();
      clock = sandbox.useFakeTimers({ now: moment(nextReminderDate).add(1, 'day').toDate(), shouldAdvanceTime: true });
      updatedOrders = await runCronJob();
      expect(updatedOrders).to.have.length(1);
      expect(updatedOrders[0].data.resumeContribution.reminder).to.equal(4);
      expect(updatedOrders[0].data.resumeContribution.nextReminderDate).to.be.null;
      expect(emailSendMessageSpy.callCount).to.equal(4);
      expect(emailSendMessageSpy.lastCall.args[0]).to.equal(contributor.email);
      expect(emailSendMessageSpy.lastCall.args[1]).to.match(
        /Final reminder: Your contribution to .* is ready to be resumed/,
      );
      expect(emailSendMessageSpy.lastCall.args[2]).to.contain(
        `/dashboard/${contributor.collective.slug}/outgoing-contributions`,
      );
      expect(emailSendMessageSpy.lastCall.args[2]).to.contain(`This is the last reminder we're sending you`);

      // No more reminders
      clock.restore();
      clock = sandbox.useFakeTimers({ now: moment(nextReminderDate).add(60, 'day').toDate(), shouldAdvanceTime: true });
      updatedOrders = await runCronJob();
      expect(updatedOrders).to.have.length(0);
    });
  });
});
