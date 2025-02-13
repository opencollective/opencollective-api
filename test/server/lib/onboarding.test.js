import { expect } from 'chai';
import { createSandbox } from 'sinon';

import emailLib from '../../../server/lib/email';
import { processHostOnBoardingTemplate, processOnBoardingTemplate } from '../../../server/lib/onboarding';
import models from '../../../server/models';
import { fakeActiveHost, fakeCollective, fakeUser } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('server/lib/onboarding', () => {
  let admins, sandbox, emailLibSendMessageSpy;

  before(async () => {
    await utils.resetTestDB();
    sandbox = createSandbox();
    emailLibSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    admins = await Promise.all([
      models.User.createUserWithCollective({ name: 'test adminUser1', email: 'testadminUser1@gmail.com' }),
      models.User.createUserWithCollective({ name: 'test adminUser2', email: 'testadminUser2@gmail.com' }),
    ]);
  });

  after(() => {
    sandbox.restore();
  });

  afterEach(() => {
    emailLibSendMessageSpy.resetHistory();
  });

  describe('processOnBoardingTemplate', () => {
    it('sends onboarding after 2 days for new organizations', async () => {
      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - 2);
      const org = await models.Collective.create({
        name: 'airbnb',
        isActive: true,
        type: 'ORGANIZATION',
        CreatedByUserId: admins[0].id,
        createdAt,
      });

      await Promise.all(
        admins.map(admin =>
          models.Member.create({
            CreatedByUserId: admins[0].id,
            CollectiveId: org.id,
            MemberCollectiveId: admin.CollectiveId,
            role: 'ADMIN',
          }),
        ),
      );

      const startsAt = new Date(createdAt);
      startsAt.setHours(0);
      await processOnBoardingTemplate('onboarding.day2', startsAt);
      expect(emailLibSendMessageSpy.firstCall.args[3].from).to.equal('Open Collective <support@opencollective.com>');
      expect(emailLibSendMessageSpy.callCount).to.equal(2);
      admins.map(admin => {
        const emailServiceCall = emailLibSendMessageSpy.args.find(([email]) => email === admin.email);
        if (!emailServiceCall) {
          throw new Error(`Looks like onboarding email was not sent to ${admin.email}`);
        }

        expect(emailServiceCall[1]).to.equal('Help us improve the Sponsor experience');
        expect(emailServiceCall[3].unsubscribeUrl).to.contain(encodeURIComponent(admin.email));
        expect(emailServiceCall[3].listId).to.equal('airbnb::onboarding');
      });
    });

    it('does not send anything if filter returns false', async () => {
      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - 2);
      const org = await models.Collective.create({
        name: 'airbnb',
        isActive: true,
        type: 'ORGANIZATION',
        CreatedByUserId: admins[0].id,
        createdAt,
      });

      await Promise.all(
        admins.map(admin =>
          models.Member.create({
            CreatedByUserId: admins[0].id,
            CollectiveId: org.id,
            MemberCollectiveId: admin.CollectiveId,
            role: 'ADMIN',
          }),
        ),
      );

      const startsAt = new Date(createdAt);
      startsAt.setHours(0);
      await processOnBoardingTemplate('onboarding.day2', startsAt, () => Promise.resolve(false));
      expect(emailLibSendMessageSpy.callCount).to.equal(0);
    });
  });

  describe('processHostOnBoardingTemplate', () => {
    describe('OSC', () => {
      let hostOSC;

      before(async () => {
        hostOSC = await fakeActiveHost({ name: 'Open Source' });
      });

      it('sends onboarding 2 days after being approved', async () => {
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        const admin = await fakeUser();
        const collective = await fakeCollective({
          admin,
          name: 'webpack',
          isActive: true,
          HostCollectiveId: hostOSC.id,
          approvedAt: twoDaysAgo,
        });

        await processHostOnBoardingTemplate('onboarding.day2.opensource', hostOSC.id, twoDaysAgo);

        expect(emailLibSendMessageSpy.callCount).to.equal(1);

        const [, subject, html, options] = emailLibSendMessageSpy.firstCall.args;
        expect(options.listId).to.equal(`${collective.slug}::onboarding`);
        expect(options.unsubscribeUrl).to.contain(encodeURIComponent(admin.email));
        expect(options.from).to.equal('Open Collective <support@opencollective.com>');
        expect(subject).to.equal('Unlock More Tools on Open Collective with OSC');
        expect(html).to.contain('Hi webpack,');
      });

      it('sends onboarding 3 days after being approved', async () => {
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        const admin = await fakeUser();
        const collective = await fakeCollective({
          admin,
          name: 'webpack',
          isActive: true,
          HostCollectiveId: hostOSC.id,
          approvedAt: twoDaysAgo,
        });

        await processHostOnBoardingTemplate('onboarding.day3.opensource', hostOSC.id, twoDaysAgo);

        expect(emailLibSendMessageSpy.callCount).to.equal(1);

        const [, subject, html, options] = emailLibSendMessageSpy.firstCall.args;
        expect(options.listId).to.equal(`${collective.slug}::onboarding`);
        expect(options.unsubscribeUrl).to.contain(encodeURIComponent(admin.email));
        expect(options.from).to.equal('Open Collective <support@opencollective.com>');
        expect(subject).to.equal('Get the Most out of Fiscal Hosting with OSC');
        expect(html).to.contain('Hi webpack,');
      });

      it('does not send anything after 7 days', async () => {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

        const admin = await fakeUser();
        await fakeCollective({
          admin,
          name: 'webpack',
          isActive: true,
          HostCollectiveId: hostOSC.id,
          approvedAt: sevenDaysAgo,
        });

        await processHostOnBoardingTemplate('onboarding.day2.opensource', hostOSC.id, twoDaysAgo);
        await processHostOnBoardingTemplate('onboarding.day3.opensource', hostOSC.id, threeDaysAgo);
        expect(emailLibSendMessageSpy.callCount).to.equal(0);
      });
    });
  });
});
