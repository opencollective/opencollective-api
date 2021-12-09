import axios from 'axios';
import { expect } from 'chai';
import { before } from 'mocha';
import { assert, createSandbox } from 'sinon';

import { activities } from '../../../server/constants';
import channels from '../../../server/constants/channels';
import emailLib from '../../../server/lib/email';
import notify from '../../../server/lib/notifications';
import slackLib from '../../../server/lib/slack';
import { fakeActivity, fakeCollective, fakeNotification, fakeUpdate, fakeUser } from '../../test-helpers/fake-data';
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
        await notify(activity);
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
        await notify(activity);
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
        await notify(activity);
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
        await notify(activity);
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
      sendEmailSpy = sandbox.spy(emailLib, 'send');
    });

    describe('check update published notifications', async () => {
      it('notifies the subscribers', async () => {
        activity.data.update = await fakeUpdate({ CollectiveId: collective.id });
        await notify(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.callCount).to.equal(1);
      });

      it('has valid html content for notification email', async () => {
        const html = '<div>Testing valid html content for notification email</div>';
        activity.data.update = await fakeUpdate({ CollectiveId: collective.id, html });
        await notify(activity);
        await utils.waitForCondition(() => sendEmailSpy.callCount === 1);
        expect(sendEmailSpy.firstCall.args[2].update.html).to.equal(html);
      });

      describe('iframes', () => {
        it('are converted to images in notification', async () => {
          const html =
            '<div>Testing valid html content for notification email<iframe src="https://www.youtube.com/watch?v=JODaYjDyjyQ&ab_channel=NPRMusic"></iframe></div>';
          activity.data.update = await fakeUpdate({ CollectiveId: collective.id, html });
          await notify(activity);
          const modifiedHtml =
            '<div>Testing valid html content for notification email<img src="https://img.youtube.com/vi/JODaYjDyjyQ/0.jpg" /></div>';
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
            await notify(activity);
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
});
