import { expect } from 'chai';
import _ from 'lodash';
import Slack from 'node-slack';
import { stub } from 'sinon';

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

    it('with message succeeds', done => {
      expectPayload(basePayload);

      callSlackLib(done, message, webhookUrl);
    });

    it('with attachment succeeds', done => {
      const attachments = ['att1', 'att2'];

      expectPayload(_.extend({}, basePayload, { attachments }));

      callSlackLib(done, message, webhookUrl, { attachments });
    });

    it('with channel succeeds', done => {
      const channel = 'kewl channel';

      expectPayload(_.extend({}, basePayload, { channel }));

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
});

function expectPayload(expectedPayload) {
  Slack.prototype.send = (actualPayload, cb) => {
    expect(actualPayload).to.deep.equal(expectedPayload);
    cb();
  };
}

function callSlackLib(done, msg, webhookUrl, options) {
  slackLib.postMessage(msg, webhookUrl, options).then(done).catch(done);
}
