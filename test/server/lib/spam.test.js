import { expect } from 'chai';
import config from 'config';
import { stub, useFakeTimers } from 'sinon';

import slackLib from '../../../server/lib/slack.js';
import { collectiveSpamCheck, notifyTeamAboutSuspiciousCollective, resolveRedirect } from '../../../server/lib/spam.js';
import { fakeCollective } from '../../test-helpers/fake-data.js';

// To prevent false positives with random values, we initialize all collectives with safe values
const LEGIT_VALUES = {
  name: 'Legit Collective',
  website: 'https://github.com/opencollective/opencollective-api',
  description: 'Open-source project',
  longDescription: '<p>Find us on Github!</p>',
  tags: ['ok'],
};

describe('server/lib/spam', () => {
  let clock;

  before(() => {
    clock = useFakeTimers(new Date('2020-01-01T00:00:00.000Z'));
  });

  after(() => {
    clock.restore();
  });

  describe('collectiveSpamCheck', () => {
    it('detects bad keywords', async () => {
      // Description
      const collectiveWithBadDescription = await fakeCollective({ ...LEGIT_VALUES, description: 'Some keto stuff' });
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
      const collectiveWithBadLongDescription = await fakeCollective({
        ...LEGIT_VALUES,
        longDescription: 'Some PORN stuff',
      });
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
      const collectiveWithBadWebsite = await fakeCollective({ ...LEGIT_VALUES, website: 'https://maxketo.com' });
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
      const collectiveWithBadName = await fakeCollective({ ...LEGIT_VALUES, name: 'BEST KeTo!!!' });
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
      const collectiveWithBlockedWebsite = await fakeCollective({
        ...LEGIT_VALUES,
        website: 'https://supplementslove.com/promotion',
      });
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

    it('detects bad domains in the URL', async () => {
      const collective = await fakeCollective({
        ...LEGIT_VALUES,
        longDescription: 'Come and buy stuff on <a href="https://dasilex.co.uk/test">our website</a>!',
      });

      expect(await collectiveSpamCheck(collective)).to.deep.eq({
        score: 1,
        keywords: [],
        domains: ['dasilex.co.uk'],
        bayes: 'ham',
        context: undefined,
        date: '2020-01-01T00:00:00.000Z',
        data: collective.info,
      });
    });

    it('is ok with legit domains', async () => {
      const collective = await fakeCollective({
        ...LEGIT_VALUES,
        longDescription: 'Come and buy stuff on <a href="https://google.fr">our website</a>!',
      });

      expect(await collectiveSpamCheck(collective)).to.deep.eq({
        score: 0,
        keywords: [],
        domains: [],
        bayes: 'ham',
        context: undefined,
        date: '2020-01-01T00:00:00.000Z',
        data: collective.info,
      });
    });
  });

  describe('notifyTeamAboutSuspiciousCollective', () => {
    let slackPostMessageStub = null;

    before(() => {
      slackPostMessageStub = stub(slackLib, 'postMessage');
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

  describe('unredirectUrl', () => {
    it('does nothing if not a redirected URL', () => {
      expect(resolveRedirect(new URL('https://google.fr')).hostname).to.eq('google.fr');
      expect(resolveRedirect(new URL(`${config.host.website}/test`)).origin).to.eq(config.host.website);
    });

    it('does not crash for invalid redirects', () => {
      expect(resolveRedirect(new URL(`${config.host.website}/redirect`)).origin).to.eq(config.host.website);
      expect(resolveRedirect(new URL(`${config.host.website}/redirect?url=something`)).origin).to.eq(
        config.host.website,
      );
    });

    it('returns the base URL', () => {
      expect(resolveRedirect(new URL(`${config.host.website}/redirect?url=https://google.fr`)).hostname).to.eq(
        'google.fr',
      );
      expect(resolveRedirect(new URL(`${config.host.website}/redirect?url=https://google.fr/test`)).hostname).to.eq(
        'google.fr',
      );
    });
  });
});
