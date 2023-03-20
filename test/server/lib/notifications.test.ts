import axios from 'axios';
import { expect } from 'chai';
import { before } from 'mocha';
import { assert, createSandbox } from 'sinon';

import { activities } from '../../../server/constants';
import channels from '../../../server/constants/channels';
import roles from '../../../server/constants/roles';
import emailLib from '../../../server/lib/email';
import notifyLib from '../../../server/lib/notifications';
import { notify } from '../../../server/lib/notifications/email';
import slackLib from '../../../server/lib/slack';
import {
  fakeActivity,
  fakeCollective,
  fakeEvent,
  fakeMember,
  fakeNotification,
  fakeOrganization,
  fakeUpdate,
  fakeUser,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';
import * as utils from '../../utils';

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

describe('server/lib/notification', function () {
  this.timeout(50000);

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
      await collective.addUserWithRole(user, 'FOLLOWER');
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
            '<div>Testing valid html content for notification email<img src="https://img.youtube.com/vi/JODaYjDyjyQ/0.jpg" alt="youtube content" /></div>';
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
});
