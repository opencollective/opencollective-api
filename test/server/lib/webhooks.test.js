import dns from 'dns';

import axios from 'axios';
import { expect } from 'chai';
import config from 'config';
import { assert, createSandbox } from 'sinon';

import { activities } from '../../../server/constants';
import channels from '../../../server/constants/channels';
import notifyLib from '../../../server/lib/notifications';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../../../server/lib/rate-limit';
import slackLib from '../../../server/lib/slack';
import {
  assertWebhookUrlAllowed,
  enrichActivityForWebhookPayload,
  isDisallowedWebhookHostname,
  isDisallowedWebhookIpAddress,
  isTrustedWebhookProviderUrl,
  sanitizeActivityForWebhookPayload,
} from '../../../server/lib/webhooks';
import { fakeActivity, fakeCollective, fakeNotification } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/lib/webhooks', () => {
  describe('webhook URL security', () => {
    let sandbox;

    beforeEach(() => {
      sandbox = createSandbox();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('detects disallowed IP ranges', () => {
      expect(isDisallowedWebhookIpAddress('127.0.0.1')).to.be.true;
      expect(isDisallowedWebhookIpAddress('10.0.0.1')).to.be.true;
      expect(isDisallowedWebhookIpAddress('169.254.169.254')).to.be.true;
      expect(isDisallowedWebhookIpAddress('::1')).to.be.true;
      expect(isDisallowedWebhookIpAddress('93.184.216.34')).to.be.false;
    });

    it('recognizes trusted webhook provider URLs', () => {
      expect(isTrustedWebhookProviderUrl('https://hooks.slack.com/services/xxx')).to.be.true;
      expect(isTrustedWebhookProviderUrl('https://discord.com/api/webhooks/123/abc')).to.be.true;
      expect(isTrustedWebhookProviderUrl('https://discordapp.com/api/webhooks/123/abc')).to.be.true;
      expect(isTrustedWebhookProviderUrl('https://chat.diglife.coop/hooks/xxxxxxxxxxxxxxx')).to.be.true;
      expect(isTrustedWebhookProviderUrl('https://example.com/webhook')).to.be.false;
      expect(isTrustedWebhookProviderUrl('http://hooks.slack.com/services/xxx')).to.be.false;
      expect(isTrustedWebhookProviderUrl('https://evil.com/hooks.slack.com/services/xxx')).to.be.false;
      expect(isTrustedWebhookProviderUrl('https://discord.com/api/webhooks/')).to.be.false;
    });

    it('rejects hostnames reserved for local or internal use', async () => {
      expect(isDisallowedWebhookHostname('localhost')).to.be.true;
      expect(isDisallowedWebhookHostname('metadata.google.internal')).to.be.true;
      expect(isDisallowedWebhookHostname('api.mycompany.local')).to.be.true;
      expect(isDisallowedWebhookHostname('example.com')).to.be.false;

      await expect(assertWebhookUrlAllowed('http://metadata.google.internal/computeMetadata/v1/')).to.be.rejectedWith(
        'Webhook URL hostname is not allowed',
      );
    });

    it('rate limits webhook URL DNS validations per user', async () => {
      sandbox.stub(config, 'limits').value({ webhookUrlValidationPerUserPerHour: 1 });
      const userId = 424242;
      const rateLimitKey = `webhook_url_validation_user_${userId}`;
      const rateLimit = new RateLimit(rateLimitKey, 1, ONE_HOUR_IN_SECONDS);
      await rateLimit.reset();
      await rateLimit.registerCall();

      const resolve4 = sandbox.stub(dns.promises, 'resolve4').resolves(['93.184.216.34']);
      sandbox.stub(dns.promises, 'resolve6').rejects(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));

      await expect(assertWebhookUrlAllowed('https://example.com/hook', { userId })).to.be.rejectedWith(
        'Too many webhook URL validations. Please wait before trying again.',
      );
      expect(resolve4).to.not.have.been.called;

      await rateLimit.reset();
    });

    it('does not rate limit trusted webhook provider URLs', async () => {
      sandbox.stub(config, 'limits').value({ webhookUrlValidationPerUserPerHour: 1 });
      const userId = 424243;
      const rateLimitKey = `webhook_url_validation_user_${userId}`;
      const rateLimit = new RateLimit(rateLimitKey, 1, ONE_HOUR_IN_SECONDS);
      await rateLimit.reset();
      await rateLimit.registerCall();

      const resolve4 = sandbox.stub(dns.promises, 'resolve4').resolves(['127.0.0.1']);
      sandbox.stub(dns.promises, 'resolve6').rejects(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));

      await assertWebhookUrlAllowed('https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX', { userId });

      expect(resolve4).to.not.have.been.called;
      await rateLimit.reset();
    });
  });

  describe('dispatch', () => {
    let sandbox, axiosPostStub, slackPostActivityOnPublicChannelStub;

    before(async () => {
      await resetTestDB();
      sandbox = createSandbox();
    });

    beforeEach(() => {
      axiosPostStub = sandbox.stub(axios, 'post').resolves({ status: 200 });
      slackPostActivityOnPublicChannelStub = sandbox.stub(slackLib, 'postActivityOnPublicChannel').resolves();
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('does not dispatch generic webhooks that resolve to loopback addresses', async () => {
      const resolve4 = sandbox.stub(dns.promises, 'resolve4');
      sandbox.stub(dns.promises, 'resolve6').rejects(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
      resolve4.onCall(0).resolves(['93.184.216.34']);
      resolve4.resolves(['127.0.0.1']);

      const collective = await fakeCollective();
      await fakeNotification({
        channel: channels.WEBHOOK,
        type: activities.COLLECTIVE_APPLY,
        CollectiveId: collective.host.id,
        webhookUrl: 'http://rebind.example/hook',
      });

      const activity = await fakeActivity(
        {
          CollectiveId: collective.id,
          type: activities.COLLECTIVE_APPLY,
          data: {
            host: collective.host.info,
            collective: collective.info,
          },
        },
        { hooks: false },
      );

      await notifyLib(activity);

      assert.notCalled(axiosPostStub);
      assert.notCalled(slackPostActivityOnPublicChannelStub);
    });

    it('still dispatches trusted provider webhooks', async () => {
      const collective = await fakeCollective();
      const notification = await fakeNotification({
        channel: channels.WEBHOOK,
        type: activities.COLLECTIVE_APPLY,
        CollectiveId: collective.host.id,
        webhookUrl: 'https://hooks.slack.com/services/xxxxx/yyyyy/zzzz',
      });

      const activity = await fakeActivity(
        {
          CollectiveId: collective.id,
          type: activities.COLLECTIVE_APPLY,
          data: {
            host: collective.host.info,
            collective: collective.info,
          },
        },
        { hooks: false },
      );

      await notifyLib(activity);

      assert.notCalled(axiosPostStub);
      assert.calledWith(slackPostActivityOnPublicChannelStub, activity, notification.webhookUrl);
    });

    it('dispatches public webhooks with pinned agents', async () => {
      sandbox.stub(dns.promises, 'resolve4').resolves(['93.184.216.34']);
      sandbox.stub(dns.promises, 'resolve6').rejects(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));

      const collective = await fakeCollective();
      const notification = await fakeNotification({
        channel: channels.WEBHOOK,
        type: activities.COLLECTIVE_APPLY,
        CollectiveId: collective.host.id,
        webhookUrl: 'https://example.com/webhook',
      });

      const activity = await fakeActivity(
        {
          CollectiveId: collective.id,
          type: activities.COLLECTIVE_APPLY,
          data: {
            host: collective.host.info,
            collective: collective.info,
          },
        },
        { hooks: false },
      );

      await notifyLib(activity);

      expect(axiosPostStub.calledOnce).to.be.true;
      const axiosConfig = axiosPostStub.firstCall.args[2];
      expect(axiosConfig.httpAgent).to.exist;
      expect(axiosConfig.httpsAgent).to.exist;
      expect(axiosPostStub.firstCall.args[0]).to.equal(notification.webhookUrl);
    });
  });

  describe('sanitizeActivity', () => {
    it('Strips the data for unknown types', () => {
      const sanitized = sanitizeActivityForWebhookPayload({ type: 'NOT_A_VALID_TYPE', data: { hello: 'world' } });
      expect(sanitized.data).to.be.empty;
    });

    it('COLLECTIVE_MEMBER_CREATED', () => {
      const sanitized = sanitizeActivityForWebhookPayload({
        type: activities.COLLECTIVE_MEMBER_CREATED,
        data: {
          order: { totalAmount: 4200 },
          member: {
            role: 'BACKER',
            memberCollective: {
              id: 42,
            },
          },
        },
      });

      expect(sanitized.data.order.totalAmount).to.eq(4200);
      expect(sanitized.data.member.memberCollective.id).to.eq(42);
      expect(sanitized.data.collective).to.not.exist;
    });

    it('Sanitizes COLLECTIVE_EXPENSE_CREATED', () => {
      const sanitized = sanitizeActivityForWebhookPayload({
        type: activities.COLLECTIVE_EXPENSE_CREATED,
        data: {
          user: {
            id: 2,
          },
          fromCollective: { slug: 'cslug' },
          expense: {
            id: 42,
            amount: 100,
            lastEditedById: 2,
          },
        },
      });

      expect(sanitized.data.expense.id).to.eq(42);
      expect(sanitized.data.expense.amount).to.eq(100);
      expect(sanitized.data.expense.lastEditedById).to.not.exist;
      expect(sanitized.data.fromCollective.slug).to.eq('cslug');
      expect(sanitized.data.user).to.not.exist;
    });

    it('Sanitizes COLLECTIVE_EXPENSE_REJECTED', () => {
      const sanitized = sanitizeActivityForWebhookPayload({
        type: activities.COLLECTIVE_EXPENSE_REJECTED,
        data: {
          user: {
            id: 2,
          },
          fromCollective: { slug: 'cslug' },
          expense: {
            id: 42,
            amount: 100,
            lastEditedById: 2,
          },
        },
      });

      expect(sanitized.data.expense.id).to.eq(42);
      expect(sanitized.data.expense.amount).to.eq(100);
      expect(sanitized.data.expense.lastEditedById).to.not.exist;
      expect(sanitized.data.fromCollective.slug).to.eq('cslug');
      expect(sanitized.data.user).to.not.exist;
    });

    it('Sanitizes TICKET_CONFIRMED', () => {
      const sanitized = sanitizeActivityForWebhookPayload({
        type: activities.TICKET_CONFIRMED,
        id: 42,
        UserId: 7676,
        data: {
          recipient: {
            name: 'Oratione Loremipsum',
            legalName: 'George Carver',
          },
          tier: {
            id: 11052,
            name: 'Test for data',
          },
          order: {
            id: 8989,
            totalAmount: 1000,
            currency: 'USD',
            tags: ['atag', 'btag'],
            TierId: 11052,
            customData: { secret: 'Do not tell' },
          },
        },
      });

      expect(sanitized.id).to.eq(42);
      expect(sanitized.data.order.id).to.eq(8989);
      expect(sanitized.data.order.UserId).to.not.exist;
      expect(sanitized.data.order.totalAmount).to.eq(1000);
      expect(sanitized.data.order.tags).to.be.an('array');
      expect(sanitized.data.order.tags).to.include('atag');
      expect(sanitized.data.order.customData).to.not.exist;
      expect(sanitized.data.recipient.name).to.eq('Oratione Loremipsum');
      expect(sanitized.data.recipient.legalName).to.not.exist;
    });
  });

  describe('enrichActivity', () => {
    it('add formattedAmount field', () => {
      const activity = {
        type: 'DoesNotReallyMatter',
        data: {
          normal: { totalAmount: 4200, currency: 'USD' },
          withInterval: { amount: 5000, currency: 'EUR', interval: 'month' },
          withoutCurrency: { amount: 150 },
        },
      };

      const enrichedActivity = enrichActivityForWebhookPayload(activity);
      expect(enrichedActivity).to.eq(activity); // base object is mutated
      expect(enrichedActivity).to.deep.eqInAnyOrder({
        type: 'DoesNotReallyMatter',
        data: {
          normal: {
            totalAmount: 4200,
            currency: 'USD',
            formattedAmount: '$42.00',
            formattedAmountWithInterval: '$42.00',
          },
          withInterval: {
            amount: 5000,
            currency: 'EUR',
            interval: 'month',
            formattedAmount: '€50.00',
            formattedAmountWithInterval: '€50.00 / month',
          },
          withoutCurrency: {
            amount: 150,
            formattedAmount: '1.50',
            formattedAmountWithInterval: '1.50',
          },
        },
      });
    });
  });
});
