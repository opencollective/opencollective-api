import { expect } from 'chai';
import config from 'config';
import sinon from 'sinon';

import slackLib from '../../../server/lib/slack';
import { collectiveSpamCheck, notifyTeamAboutSuspiciousCollective } from '../../../server/lib/spam';
import { fakeCollective } from '../../test-helpers/fake-data';

describe('server/lib/spam', () => {
  let clock;

  before(() => {
    clock = sinon.useFakeTimers(new Date('2020-01-01T00:00:00.000Z'));
  });

  after(() => {
    clock.restore();
  });

  describe('collectiveSpamCheck', () => {
    it('detects bad keywords', async () => {
      // Description
      const collectiveWithBadDescription = await fakeCollective({ description: 'Some keto stuff' });
      expect(await collectiveSpamCheck(collectiveWithBadDescription, 'test')).to.deep.eq({
        score: 0.3,
        keywords: ['keto'],
        domains: [],
        bayes: 'ham',
        context: 'test',
        data: collectiveWithBadDescription.info,
        date: '2020-01-01T00:00:00.000Z',
      });

      // Long description
      const collectiveWithBadLongDescription = await fakeCollective({ longDescription: 'Some PORN stuff' });
      expect(await collectiveSpamCheck(collectiveWithBadLongDescription)).to.deep.eq({
        score: 0.2,
        keywords: ['porn'],
        domains: [],
        bayes: 'ham',
        context: undefined,
        date: '2020-01-01T00:00:00.000Z',
        data: collectiveWithBadLongDescription.info,
      });

      // Website
      const collectiveWithBadWebsite = await fakeCollective({ website: 'https://maxketo.com' });
      expect(await collectiveSpamCheck(collectiveWithBadWebsite)).to.deep.eq({
        score: 0.3,
        keywords: ['keto'],
        domains: [],
        bayes: 'ham',
        context: undefined,
        date: '2020-01-01T00:00:00.000Z',
        data: collectiveWithBadWebsite.info,
      });

      // Name
      const collectiveWithBadName = await fakeCollective({ name: 'BEST KeTo!!!' });
      expect(await collectiveSpamCheck(collectiveWithBadName)).to.deep.eq({
        score: 0.3,
        keywords: ['keto'],
        domains: [],
        bayes: 'ham',
        context: undefined,
        date: '2020-01-01T00:00:00.000Z',
        data: collectiveWithBadName.info,
      });
    });

    it('detects blocked websites', async () => {
      // Website
      const collectiveWithBlockedWebsite = await fakeCollective({ website: 'https://supplementslove.com/promotion' });
      expect(await collectiveSpamCheck(collectiveWithBlockedWebsite)).to.deep.eq({
        score: 1,
        keywords: [],
        domains: ['supplementslove.com'],
        bayes: 'ham',
        context: undefined,
        date: '2020-01-01T00:00:00.000Z',
        data: collectiveWithBlockedWebsite.info,
      });
    });
  });

  describe('notifyTeamAboutSuspiciousCollective', () => {
    let slackPostMessageStub = null;

    before(() => {
      slackPostMessageStub = sinon.stub(slackLib, 'postMessage');
    });

    after(() => {
      slackPostMessageStub.restore();
    });

    it('notifies Slack with the report info', async () => {
      const report = await collectiveSpamCheck({ name: 'Keto stuff', slug: 'ketoooo' });
      await notifyTeamAboutSuspiciousCollective(report);
      expect(slackPostMessageStub.calledOnce).to.be.true;

      const args = slackPostMessageStub.getCall(0).args;
      expect(args[0]).to.eq(
        '*Suspicious collective data was submitted for collective:* https://opencollective.com/ketoooo\nScore: 0.3\nKeywords: `keto`',
      );
      expect(args[1]).to.eq(config.slack.webhooks.abuse);
    });
  });
});
