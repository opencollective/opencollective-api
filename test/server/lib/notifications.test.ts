import axios from 'axios';
import { expect } from 'chai';
import { before } from 'mocha';
import { assert, createSandbox } from 'sinon';

import { activities } from '../../../server/constants';
import channels from '../../../server/constants/channels';
import roles from '../../../server/constants/roles';
import emailLib from '../../../server/lib/email';
import notifyLib from '../../../server/lib/notifications';
import { notify, notifyByEmail } from '../../../server/lib/notifications/email';
import slackLib from '../../../server/lib/slack';
import { CommentType } from '../../../server/models/Comment';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeEvent,
  fakeExpense,
  fakeMember,
  fakeNotification,
  fakeOrganization,
  fakeUpdate,
  fakeUser,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';
import { resetTestDB } from '../../utils';

const generateCollectiveActivity = async (collective, activityType, fromCollective = null) => {
  return fakeActivity(
    {
      CollectiveId: collective.id,
      type: activityType,
      data: {
        host: collective.host.info,
        collective: collective.info,
        fromCollective,
        user: (await fakeUser()).info,
      },
    },
    // Pass hooks false to only trigger `notify` manually
    { hooks: false },
  );
};

describe('server/lib/notification', () => {
  let sandbox, axiosPostStub, slackPostActivityOnPublicChannelStub;

  before(async () => {
    await resetTestDB();
    sandbox = createSandbox();
  });

  beforeEach(() => {
    axiosPostStub = sandbox.stub(axios, 'post').resolves();
    slackPostActivityOnPublicChannelStub = sandbox.stub(slackLib, 'postActivityOnPublicChannel').resolves();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('notify', () => {
    describe('with channels.WEBHOOK', () => {
      it('posts to regular webhooks', async () => {
        const collective = await fakeCollective();
        const notification = await fakeNotification({
          channel: channels.WEBHOOK,
          type: activities.COLLECTIVE_APPLY,
          CollectiveId: collective.host.id,
        });

        const activity = await generateCollectiveActivity(collective, activities.COLLECTIVE_APPLY);
        await notifyLib(activity);
        assert.calledWithMatch(axiosPostStub, notification.webhookUrl, { type: 'collective.apply' });
      });

      it('posts to slack webhooks', async () => {
        const collective = await fakeCollective();
        const notification = await fakeNotification({
          channel: channels.WEBHOOK,
          type: activities.COLLECTIVE_APPLY,
          CollectiveId: collective.host.id,
          webhookUrl: 'https://hooks.slack.com/services/xxxxx/yyyyy/zzzz',
        });

        const activity = await generateCollectiveActivity(collective, activities.COLLECTIVE_APPLY);
        await notifyLib(activity);
        assert.notCalled(axiosPostStub);
        assert.calledWith(slackPostActivityOnPublicChannelStub, activity, notification.webhookUrl);
      });

      it("posts to discord's slack-compatible webhooks", async () => {
        const collective = await fakeCollective();
        const notification = await fakeNotification({
          channel: channels.WEBHOOK,
          type: activities.COLLECTIVE_APPLY,
          CollectiveId: collective.host.id,
          webhookUrl: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyyyy/slack',
        });

        const activity = await generateCollectiveActivity(collective, activities.COLLECTIVE_APPLY);
        await notifyLib(activity);
        assert.notCalled(axiosPostStub);
        assert.calledWith(slackPostActivityOnPublicChannelStub, activity, notification.webhookUrl);
      });

      it("posts to Mattermost's slack-compatible webhooks", async () => {
        const collective = await fakeCollective();
        const notification = await fakeNotification({
          channel: channels.WEBHOOK,
          type: activities.COLLECTIVE_APPLY,
          CollectiveId: collective.host.id,
          webhookUrl: 'https://chat.diglife.coop/hooks/xxxxxxxxxxxxxxx',
        });

        const activity = await generateCollectiveActivity(collective, activities.COLLECTIVE_APPLY);
        await notifyLib(activity);
        assert.notCalled(axiosPostStub);
        assert.calledWith(slackPostActivityOnPublicChannelStub, activity, notification.webhookUrl);
      });
    });
  });

  describe('notifySubscribers', () => {
    let collective, fromCollective, activity, sendEmailSpy;

    before(async () => {
      collective = await fakeCollective();
      const user = await fakeUser();
      await collective.addUserWithRole(user, 'BACKER');
      fromCollective = await fakeCollective();
      activity = await generateCollectiveActivity(collective, activities.COLLECTIVE_UPDATE_PUBLISHED, fromCollective);
    });

    beforeEach(async () => {
      sendEmailSpy = sandbox.stub(emailLib, 'send');
    });

    describe('check update published notifications', async () => {
      it('notifies the subscribers', async () => {
        activity.data.update = await fakeUpdate({ CollectiveId: collective.id });
        await notifyLib(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.callCount).to.equal(1);
      });

      it('has valid html content for notification email', async () => {
        const html = '<div>Testing valid html content for notification email</div>';
        activity.data.update = await fakeUpdate({ CollectiveId: collective.id, html });
        await notifyLib(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.firstCall.args[2].update.html).to.equal(html);
      });

      describe('iframes', () => {
        it('are converted to images in notification', async () => {
          const html =
            '<div>Testing valid html content for notification email<iframe src="https://www.youtube.com/watch?v=JODaYjDyjyQ&ab_channel=NPRMusic"></iframe></div>';
          activity.data.update = await fakeUpdate({ CollectiveId: collective.id, html });
          await notifyLib(activity);
          const modifiedHtml =
            '<div>Testing valid html content for notification email<a href="https://www.youtube.com/watch?v=JODaYjDyjyQ"><img src="https://img.youtube.com/vi/JODaYjDyjyQ/0.jpg" alt="youtube content" /></a></div>';
          await utils.waitForCondition(() => sendEmailSpy.callCount === 1);
          expect(sendEmailSpy.firstCall.args[2].update.html).to.equal(modifiedHtml);
        });

        it('are converted to images for youtube-nocookie embed iframes in figure', async () => {
          const html =
            '<div>Content before<br /><figure data-trix-content-type="--embed-iframe-video"><iframe src="https://www.youtube-nocookie.com/embed/KLeHuFu_zIM?showinfo=0" width="100%" height="394"></iframe><figcaption></figcaption></figure><br />Content after</div>';
          activity.data.update = await fakeUpdate({ CollectiveId: collective.id, html });
          await notifyLib(activity);
          const modifiedHtml =
            '<div>Content before<br /><figure data-trix-content-type="--embed-iframe-video"><a href="https://www.youtube.com/watch?v=KLeHuFu_zIM"><img src="https://img.youtube.com/vi/KLeHuFu_zIM/0.jpg" alt="youtube content" /></a><figcaption></figcaption></figure><br />Content after</div>';
          await utils.waitForCondition(() => sendEmailSpy.callCount === 1);
          expect(sendEmailSpy.firstCall.args[2].update.html).to.equal(modifiedHtml);
        });

        it('cannot be abused to inject malicious code', async () => {
          const tests = [
            '<div>Test<iframe src="https://www.youtube.com/watch?v=X<script>xxx</script>XX\\"YY<script>xxx</script>Y><</iframe>"\'aYjD<script>xxx</script></aler>yjyQ&ab_channel=NPRMusic"></iframe>',
            '<div>Test<iframe src="https://www.youtube.com/watch?v=xxx<script></script>"></iframe>',
            '<div>Test<iframe src="https://www.youtube.com/watch?v=xxx<script></script>yyy"></iframe>',
            '<div>Test<iframe src="https://www.test.com/watch?v=xxx<script></script>"></iframe>',
          ];
          const updates = await Promise.all(tests.map(html => fakeUpdate({ CollectiveId: collective.id, html })));

          for (const update of updates) {
            const activityType = activities.COLLECTIVE_UPDATE_PUBLISHED;
            const activity = await generateCollectiveActivity(collective, activityType, fromCollective);
            activity.data.update = update;
            await notifyLib(activity);
          }

          await utils.waitForCondition(() => sendEmailSpy.callCount === tests.length);

          for (const call of sendEmailSpy.getCalls()) {
            const result = call.args[2].update.html;
            expect(result).to.not.contain('<script>');
            expect(result).to.not.contain('<iframe>'); // All iframes should be stripped when unknown
          }
        });
      });
    });
  });

  describe('notifyAdminsOfCollective', () => {
    let sendEmailSpy;
    const notifyAdminsOfCollective = async (collectiveId, activity, options = {}) =>
      notify.collective(activity, { ...options, collectiveId });

    beforeEach(async () => {
      sendEmailSpy = sandbox.stub(emailLib, 'send').resolves();
    });

    it('notifies only admins', async () => {
      const collective = await fakeCollective();
      const activity = { type: activities.ACTIVITY_ALL, CollectiveId: collective.id, data: {} };

      // Some random members to make sure our select query is working
      await fakeMember();
      await fakeMember();

      // Add a bunch of members to the collective
      const backerOrg = await fakeOrganization();
      const backerUser = await fakeUser();
      const adminUser = await fakeUser();
      const accountantUser = await fakeUser();
      const memberUser = await fakeUser();

      const addMember = (MemberCollectiveId, role) =>
        fakeMember({ CollectiveId: collective.id, MemberCollectiveId, role });
      await addMember(backerOrg.id, 'BACKER');
      await addMember(backerUser.CollectiveId, 'BACKER');
      await addMember(adminUser.CollectiveId, 'ADMIN');
      await addMember(accountantUser.CollectiveId, 'ACCOUNTANT');
      await addMember(memberUser.CollectiveId, 'MEMBER');

      // Checks
      await notifyAdminsOfCollective(collective.id, activity);
      expect(sendEmailSpy.callCount).to.equal(1);
      expect(sendEmailSpy.firstCall.args[1]).to.equal(adminUser.email);
    });
  });

  describe('notifyAdminsAndAccountantsOfCollective', () => {
    let sendEmailSpy;
    const notifyAdminsAndAccountantsOfCollective = async (collectiveId, activity, options = {}) =>
      notify.collective(activity, { ...options, collectiveId, role: [roles.ACCOUNTANT, roles.ADMIN] });

    beforeEach(async () => {
      sendEmailSpy = sandbox.stub(emailLib, 'send');
    });

    it('notifies only admins and accountants', async () => {
      const collective = await fakeCollective();
      const activity = { type: activities.ACTIVITY_ALL, CollectiveId: collective.id, data: {} };

      // Some random members to make sure our select query is working
      await fakeMember();
      await fakeMember();

      // Add a bunch of members to the collective
      const backerOrg = await fakeOrganization();
      const backerUser = await fakeUser();
      const adminUser = await fakeUser();
      const accountantUser = await fakeUser();
      const memberUser = await fakeUser();

      const addMember = (MemberCollectiveId, role) =>
        fakeMember({ CollectiveId: collective.id, MemberCollectiveId, role });
      await addMember(backerOrg.id, 'BACKER');
      await addMember(backerUser.CollectiveId, 'BACKER');
      await addMember(adminUser.CollectiveId, 'ADMIN');
      await addMember(accountantUser.CollectiveId, 'ACCOUNTANT');
      await addMember(memberUser.CollectiveId, 'MEMBER');

      // Checks
      await notifyAdminsAndAccountantsOfCollective(collective.id, activity);
      expect(sendEmailSpy.callCount).to.equal(2);
      assert.calledWithMatch(sendEmailSpy, 'all', adminUser.email);
      assert.calledWithMatch(sendEmailSpy, 'all', accountantUser.email);
    });

    it('notifies only admins and accountants of parent', async () => {
      const collective = await fakeCollective();
      const event = await fakeEvent({ ParentCollectiveId: collective.id });
      const activity = { type: activities.ACTIVITY_ALL, CollectiveId: event.id, data: {} };

      // Some random members to make sure our select query is working
      await fakeMember();
      await fakeMember();

      // Add a bunch of members
      const backerOrg = await fakeOrganization();
      const backerUser = await fakeUser();
      const adminUser = await fakeUser();
      const accountantUser = await fakeUser();
      const memberUser = await fakeUser();

      const addMemberToEvent = (MemberCollectiveId, role) =>
        fakeMember({ CollectiveId: event.id, MemberCollectiveId, role });
      const addMemberToParent = (MemberCollectiveId, role) =>
        fakeMember({ CollectiveId: collective.id, MemberCollectiveId, role });
      await addMemberToParent(backerOrg.id, 'BACKER');
      await addMemberToParent(backerUser.CollectiveId, 'BACKER');
      await addMemberToParent(adminUser.CollectiveId, 'ADMIN');
      await addMemberToParent(accountantUser.CollectiveId, 'ACCOUNTANT');
      await addMemberToParent(memberUser.CollectiveId, 'MEMBER');

      await addMemberToEvent(backerOrg.id, 'BACKER');
      await addMemberToEvent(backerUser.CollectiveId, 'BACKER');

      // Checks
      await notifyAdminsAndAccountantsOfCollective(event.id, activity);
      expect(sendEmailSpy.callCount).to.equal(2);
      assert.calledWithMatch(sendEmailSpy, 'all', adminUser.email);
      assert.calledWithMatch(sendEmailSpy, 'all', accountantUser.email);
    });
  });

  describe('notifyByEmail replyTo', () => {
    let sendEmailSpy;
    const replyToEmail = 'host-reply@example.com';

    beforeEach(() => {
      sendEmailSpy = sandbox.stub(emailLib, 'send').resolves();
    });

    const getReplyToFromSendCall = call => call.args[3]?.replyTo;

    describe('COLLECTIVE_APPROVED', () => {
      it('sets replyTo from host replyToEmail', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin, data: { replyToEmail } });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const activity = await fakeActivity({
          type: activities.COLLECTIVE_APPROVED,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          data: {
            collective: collective.info,
            host: host.info,
            user: { email: hostAdmin.email },
          },
        });

        await notifyByEmail(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount >= 1);
        expect(getReplyToFromSendCall(sendEmailSpy.firstCall)).to.equal(replyToEmail);
      });

      it('does not set replyTo when host has no replyToEmail', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const activity = await fakeActivity({
          type: activities.COLLECTIVE_APPROVED,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          data: {
            collective: collective.info,
            host: host.info,
            user: { email: hostAdmin.email },
          },
        });

        await notifyByEmail(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount >= 1);
        expect(getReplyToFromSendCall(sendEmailSpy.firstCall)).to.be.undefined;
      });
    });

    describe('COLLECTIVE_REJECTED', () => {
      it('sets replyTo from host replyToEmail', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin, data: { replyToEmail } });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const activity = await fakeActivity({
          type: activities.COLLECTIVE_REJECTED,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          data: {
            collective: collective.info,
            host: host.info,
            user: { email: hostAdmin.email },
          },
        });

        await notifyByEmail(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount >= 1);
        expect(getReplyToFromSendCall(sendEmailSpy.firstCall)).to.equal(replyToEmail);
      });
    });

    describe('COLLECTIVE_UNHOSTED', () => {
      it('sets replyTo from host replyToEmail', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin, data: { replyToEmail } });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const activity = await fakeActivity({
          type: activities.COLLECTIVE_UNHOSTED,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          data: {
            collective: collective.info,
            host: host.info,
          },
        });

        await notifyByEmail(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount >= 1);
        expect(getReplyToFromSendCall(sendEmailSpy.firstCall)).to.equal(replyToEmail);
      });

      it('falls back to support@opencollective.com when host has no replyToEmail', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
        const activity = await fakeActivity({
          type: activities.COLLECTIVE_UNHOSTED,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          data: {
            collective: collective.info,
            host: host.info,
          },
        });

        await notifyByEmail(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount >= 1);
        expect(getReplyToFromSendCall(sendEmailSpy.firstCall)).to.equal('support@opencollective.com');
      });
    });

    describe('HOST_APPLICATION_COMMENT_CREATED', () => {
      it('sets replyTo from host replyToEmail when comment is from a host admin', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin, data: { replyToEmail } });
        const collectiveAdmin = await fakeUser();
        const collective = await fakeCollective({
          HostCollectiveId: host.id,
          admin: collectiveAdmin,
          isActive: false,
          approvedAt: null,
        });
        const activity = await fakeActivity({
          type: activities.HOST_APPLICATION_COMMENT_CREATED,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          FromCollectiveId: hostAdmin.CollectiveId,
          UserId: hostAdmin.id,
          data: {
            collective: collective.info,
            host: host.info,
            comment: { type: CommentType.COMMENT },
          },
        });

        await notifyByEmail(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount >= 1);
        expect(getReplyToFromSendCall(sendEmailSpy.firstCall)).to.equal(replyToEmail);
      });
    });

    describe('COLLECTIVE_APPLY', () => {
      it('sets replyTo to the applicant email on the host notification', async () => {
        const hostAdmin = await fakeUser();
        const host = await fakeActiveHost({ admin: hostAdmin, data: { replyToEmail } });
        const applicant = await fakeUser();
        const collective = await fakeCollective({ HostCollectiveId: host.id, admin: applicant });
        const activity = await fakeActivity({
          type: activities.COLLECTIVE_APPLY,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          data: {
            collective: collective.info,
            host: host.info,
            user: { email: applicant.email },
          },
        });

        await notifyByEmail(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount >= 2);
        const hostAdminEmailCall = sendEmailSpy.getCalls().find(call => call.args[1] === hostAdmin.email);
        expect(hostAdminEmailCall).to.exist;
        expect(getReplyToFromSendCall(hostAdminEmailCall)).to.equal(applicant.email);
      });
    });
  });

  describe('notifyByEmail EXPENSE_COMMENT_CREATED', () => {
    let sendEmailSpy;

    beforeEach(() => {
      sendEmailSpy = sandbox.stub(emailLib, 'send').resolves();
    });

    const notifyExpenseComment = async (collective, commenter, expense) => {
      const activity = await fakeActivity(
        {
          type: activities.EXPENSE_COMMENT_CREATED,
          CollectiveId: collective.id,
          HostCollectiveId: collective.HostCollectiveId,
          FromCollectiveId: commenter.CollectiveId,
          UserId: commenter.id,
          ExpenseId: expense.id,
          data: {
            comment: { id: 1, html: 'Hello', type: CommentType.COMMENT },
            FromCollectiveId: commenter.CollectiveId,
            expense: expense.info, // Same shape as `createComment`
          },
        },
        { hooks: false },
      );
      await notifyByEmail(activity);
      return sendEmailSpy.getCalls().map(call => call.args[1]);
    };

    it('notifies the author of a self-submitted expense only once', async () => {
      const host = await fakeActiveHost({ admin: await fakeUser() });
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin });
      await fakeUser(); // Shift user ids so that `User.id` and `User.CollectiveId` don't match by coincidence
      const author = await fakeUser();
      expect(author.id).to.not.equal(author.CollectiveId);
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        UserId: author.id,
        FromCollectiveId: author.CollectiveId,
      });

      const recipients = await notifyExpenseComment(collective, collectiveAdmin, expense);
      expect(recipients.filter(email => email === author.email)).to.have.length(1);
    });

    it('notifies a user who is admin of both the host and the collective only once', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const collective = await fakeCollective({ HostCollectiveId: host.id, admin });
      const author = await fakeUser();
      const commenter = await fakeUser();
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        UserId: author.id,
        FromCollectiveId: author.CollectiveId,
      });

      const recipients = await notifyExpenseComment(collective, commenter, expense);
      expect(recipients.filter(email => email === admin.email)).to.have.length(1);
    });

    it('still notifies an admin of both host and collective who unsubscribed on the host only', async () => {
      const admin = await fakeUser();
      const host = await fakeActiveHost({ admin });
      const collective = await fakeCollective({ HostCollectiveId: host.id, admin });
      await fakeNotification({
        channel: channels.EMAIL,
        type: activities.EXPENSE_COMMENT_CREATED,
        active: false,
        CollectiveId: host.id,
        UserId: admin.id,
      });
      await fakeNotification({
        channel: channels.EMAIL,
        type: activities.EXPENSE_COMMENT_CREATED,
        active: true,
        CollectiveId: collective.id,
        UserId: admin.id,
      });
      const author = await fakeUser();
      const commenter = await fakeUser();
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        UserId: author.id,
        FromCollectiveId: author.CollectiveId,
      });

      const recipients = await notifyExpenseComment(collective, commenter, expense);
      expect(recipients.filter(email => email === admin.email)).to.have.length(1);
    });

    it('notifies the admins only once for an expense on the host own account', async () => {
      const commenter = await fakeUser();
      const otherAdmin = await fakeUser();
      const host = await fakeActiveHost({ admin: commenter });
      await host.addUserWithRole(otherAdmin, roles.ADMIN);
      expect(host.HostCollectiveId).to.eq(host.id);
      const author = await fakeUser();
      const expense = await fakeExpense({
        CollectiveId: host.id,
        UserId: author.id,
        FromCollectiveId: author.CollectiveId,
      });

      const recipients = await notifyExpenseComment(host, commenter, expense);
      expect(recipients.filter(email => email === otherAdmin.email)).to.have.length(1);
    });
  });

  describe('COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT', () => {
    let sendEmailSpy, host, hostAdmin, otherHostAdmin, collective;

    beforeEach(async () => {
      sendEmailSpy = sandbox.stub(emailLib, 'send').resolves();
      hostAdmin = await fakeUser();
      otherHostAdmin = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin });
      await fakeMember({ CollectiveId: host.id, MemberCollectiveId: otherHostAdmin.CollectiveId, role: roles.ADMIN });
      collective = await fakeCollective({ HostCollectiveId: host.id });
    });

    const fakeScheduledActivity = payoutMethodType =>
      fakeActivity(
        {
          type: activities.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          UserId: hostAdmin.id,
          data: {
            host: host.info,
            collective: collective.info,
            fromCollective: collective.info,
            expense: { id: 42, amount: 100_00, currency: 'USD', description: 'Invoice' },
            payoutMethod: { type: payoutMethodType, data: { email: 'payee@example.com' } },
          },
        },
        { hooks: false },
      );

    it('notifies the other host admins of a scheduled PayPal payout', async () => {
      await notifyByEmail(await fakeScheduledActivity('PAYPAL'));
      await utils.waitForCondition(() => sendEmailSpy.callCount >= 1);

      expect(sendEmailSpy.callCount).to.eq(1);
      expect(sendEmailSpy.firstCall.args[0]).to.eq('collective.expense.scheduledForPayment.for.host');
      expect(sendEmailSpy.firstCall.args[1]).to.eq(otherHostAdmin.email);
    });

    it('notifies the host admins who turned off expense notifications, unless they unsubscribed from this one', async () => {
      const unsubscribedAdmin = await fakeUser();
      await fakeMember({
        CollectiveId: host.id,
        MemberCollectiveId: unsubscribedAdmin.CollectiveId,
        role: roles.ADMIN,
      });
      const unsubscribe = (user, type) =>
        fakeNotification({
          channel: channels.EMAIL,
          type,
          active: false,
          UserId: user.id,
          CollectiveId: host.id,
          webhookUrl: null,
        });
      await unsubscribe(otherHostAdmin, 'expenses');
      await unsubscribe(unsubscribedAdmin, 'collective.expense.scheduledForPayment.for.host');

      await notifyByEmail(await fakeScheduledActivity('PAYPAL'));
      await utils.waitForCondition(() => sendEmailSpy.callCount >= 1);

      expect(sendEmailSpy.callCount).to.eq(1);
      expect(sendEmailSpy.firstCall.args[1]).to.eq(otherHostAdmin.email);
    });

    it('still notifies the other host admins when sending to one of them fails', async () => {
      const thirdHostAdmin = await fakeUser();
      await fakeMember({ CollectiveId: host.id, MemberCollectiveId: thirdHostAdmin.CollectiveId, role: roles.ADMIN });
      sendEmailSpy.callsFake(async (template, email) => {
        if (email === otherHostAdmin.email) {
          throw new Error('Recipient address rejected');
        }
      });

      await notifyByEmail(await fakeScheduledActivity('PAYPAL'));

      const recipients = sendEmailSpy.getCalls().map(call => call.args[1]);
      expect(recipients).to.have.members([otherHostAdmin.email, thirdHostAdmin.email]);
    });

    it('does not notify for Wise payouts, which are only sent when the batch is paid', async () => {
      await notifyByEmail(await fakeScheduledActivity('BANK_ACCOUNT'));
      await utils.sleep(100);
      expect(sendEmailSpy.called).to.be.false;
    });
  });
});
