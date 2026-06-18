import axios from 'axios';
import { expect } from 'chai';
import _ from 'lodash';
import { createSandbox, stub } from 'sinon';

import activitiesLib from '../../../server/lib/activities';
import slackLib from '../../../server/lib/slack';

describe('server/lib/slack', () => {
  describe('calling postMessage', () => {
    const message = 'lorem ipsum';
    const webhookUrl = 'hookurl';
    const basePayload = {
      text: message,
      username: 'OpenCollective Activity Bot',
      icon_url: 'https://opencollective.com/favicon.ico', // eslint-disable-line camelcase
      attachments: [],
    };

    let sandbox;
    beforeEach(async () => {
      sandbox = createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('with message succeeds', done => {
      expectPayload(sandbox, basePayload);

      callSlackLib(done, message, webhookUrl);
    });

    it('with attachment succeeds', done => {
      const attachments = ['att1', 'att2'];

      expectPayload(sandbox, _.extend({}, basePayload, { attachments }));

      callSlackLib(done, message, webhookUrl, { attachments });
    });

    it('with channel succeeds', done => {
      const channel = 'kewl channel';

      expectPayload(sandbox, _.extend({}, basePayload, { channel }));

      callSlackLib(done, message, webhookUrl, { channel });
    });
  });

  describe('calling postActivity', () => {
    let formatMessageStub, postMessageStub;
    const activity = 'my activity';
    const formattedMessage = 'my formatted activity';
    const webhookUrl = 'hookurl';

    beforeEach(() => {
      formatMessageStub = stub(activitiesLib, 'formatMessageForPublicChannel');
      postMessageStub = stub(slackLib, 'postMessage');
    });

    afterEach(() => {
      formatMessageStub.restore();
      postMessageStub.restore();
    });

    it('with activity succeeds', done => {
      formatMessageStub.withArgs(activity, 'slack').returns({ message: formattedMessage });

      const expected = postMessageStub.withArgs(formattedMessage, webhookUrl);

      slackLib.postActivityOnPublicChannel(activity, webhookUrl);

      expect(expected.called).to.be.ok;
      done();
    });
  });

  describe('isSlackWebhookUrl', () => {
    it('recognizes Slack webhook URLs', () => {
      expect(slackLib.isSlackWebhookUrl('https://hooks.slack.com/services/T000/B000/XXXX')).to.be.true;
    });

    it('recognizes Discord webhook URLs', () => {
      expect(slackLib.isSlackWebhookUrl('https://discord.com/api/webhooks/123/abc')).to.be.true;
      expect(slackLib.isSlackWebhookUrl('https://discordapp.com/api/webhooks/123/abc')).to.be.true;
    });

    it('recognizes known Mattermost webhook URLs', () => {
      expect(slackLib.isSlackWebhookUrl('https://chat.diglife.coop/hooks/xxxxxxxxxxxxxxx')).to.be.true;
    });

    it('rejects non-provider webhook URLs', () => {
      expect(slackLib.isSlackWebhookUrl('https://example.com/webhook')).to.be.false;
      expect(slackLib.isSlackWebhookUrl('not-a-url')).to.be.false;
    });

    it('rejects lookalike URLs that do not parse to trusted hosts', () => {
      expect(slackLib.isSlackWebhookUrl('http://hooks.slack.com/services/xxx')).to.be.false;
      expect(slackLib.isSlackWebhookUrl('https://evil.com/hooks.slack.com/services/xxx')).to.be.false;
      expect(slackLib.isSlackWebhookUrl('https://discord.com/not-webhooks/123')).to.be.false;
      expect(slackLib.isSlackWebhookUrl('https://discord.com/api/webhooks/')).to.be.false;
    });
  });

  describe('postMessage Discord URL handling', () => {
    const message = 'hello';
    let sandbox, originalTestSlack;

    beforeEach(() => {
      sandbox = createSandbox();
      originalTestSlack = process.env.TEST_SLACK;
      process.env.TEST_SLACK = '1';
    });

    afterEach(() => {
      sandbox.restore();
      if (originalTestSlack === undefined) {
        delete process.env.TEST_SLACK;
      } else {
        process.env.TEST_SLACK = originalTestSlack;
      }
    });

    it('appends /slack to Discord webhooks that are missing it', async () => {
      const axiosPost = sandbox.stub(axios, 'post').resolves({ status: 200 });
      const webhookUrl = 'https://discord.com/api/webhooks/123/abc';

      await slackLib.postMessage(message, webhookUrl);

      expect(axiosPost.calledOnce).to.be.true;
      expect(axiosPost.firstCall.args[0]).to.equal('https://discord.com/api/webhooks/123/abc/slack');
    });

    it('does not modify Discord webhooks that already end with /slack', async () => {
      const axiosPost = sandbox.stub(axios, 'post').resolves({ status: 200 });
      const webhookUrl = 'https://discord.com/api/webhooks/123/abc/slack';

      await slackLib.postMessage(message, webhookUrl);

      expect(axiosPost.calledOnce).to.be.true;
      expect(axiosPost.firstCall.args[0]).to.equal(webhookUrl);
    });

    it('does not modify non-Discord webhook URLs', async () => {
      const axiosPost = sandbox.stub(axios, 'post').resolves({ status: 200 });
      const webhookUrl = 'https://hooks.slack.com/services/T000/B000/XXXX';

      await slackLib.postMessage(message, webhookUrl);

      expect(axiosPost.calledOnce).to.be.true;
      expect(axiosPost.firstCall.args[0]).to.equal(webhookUrl);
    });
  });
});

function expectPayload(sandbox, expectedPayload) {
  sandbox.stub(axios, 'post').callsFake((url, actualPayload) => {
    expect(actualPayload).to.deep.equal(expectedPayload);
    return;
  });
}

function callSlackLib(done, msg, webhookUrl, options) {
  slackLib.postMessage(msg, webhookUrl, options).then(done).catch(done);
}
