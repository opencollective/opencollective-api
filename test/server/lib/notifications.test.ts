import axios from 'axios';
import sinon from 'sinon';

import { activities } from '../../../server/constants';
import channels from '../../../server/constants/channels';
import notify from '../../../server/lib/notifications';
import slackLib from '../../../server/lib/slack';
import { fakeActivity, fakeCollective, fakeNotification, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const generateCollectiveApplyActivity = async collective => {
  return fakeActivity(
    {
      CollectiveId: collective.id,
      type: activities.COLLECTIVE_APPLY,
      data: {
        host: collective.host.info,
        collective: collective.info,
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
    sandbox = sinon.createSandbox();
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

        const activity = await generateCollectiveApplyActivity(collective);
        await notify(activity);
        sinon.assert.calledWithMatch(axiosPostStub, notification.webhookUrl, { type: 'collective.apply' });
      });

      it('posts to slack webhooks', async () => {
        const collective = await fakeCollective();
        const notification = await fakeNotification({
          channel: channels.WEBHOOK,
          type: activities.COLLECTIVE_APPLY,
          CollectiveId: collective.host.id,
          webhookUrl: 'https://hooks.slack.com/services/xxxxx/yyyyy/zzzz',
        });

        const activity = await generateCollectiveApplyActivity(collective);
        await notify(activity);
        sinon.assert.notCalled(axiosPostStub);
        sinon.assert.calledWith(slackPostActivityOnPublicChannelStub, activity, notification.webhookUrl);
      });

      it("posts to discord's slack-compatible webhooks", async () => {
        const collective = await fakeCollective();
        const notification = await fakeNotification({
          channel: channels.WEBHOOK,
          type: activities.COLLECTIVE_APPLY,
          CollectiveId: collective.host.id,
          webhookUrl: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyyyy/slack',
        });

        const activity = await generateCollectiveApplyActivity(collective);
        await notify(activity);
        sinon.assert.notCalled(axiosPostStub);
        sinon.assert.calledWith(slackPostActivityOnPublicChannelStub, activity, notification.webhookUrl);
      });

      it("posts to Mattermost's slack-compatible webhooks", async () => {
        const collective = await fakeCollective();
        const notification = await fakeNotification({
          channel: channels.WEBHOOK,
          type: activities.COLLECTIVE_APPLY,
          CollectiveId: collective.host.id,
          webhookUrl: 'https://chat.diglife.coop/hooks/xxxxxxxxxxxxxxx',
        });

        const activity = await generateCollectiveApplyActivity(collective);
        await notify(activity);
        sinon.assert.notCalled(axiosPostStub);
        sinon.assert.calledWith(slackPostActivityOnPublicChannelStub, activity, notification.webhookUrl);
      });
    });
  });
});
