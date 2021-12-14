import Promise from 'bluebird';
import { expect } from 'chai';
import { createSandbox } from 'sinon';

import emailLib from '../../../server/lib/email';
import { processOnBoardingTemplate } from '../../../server/lib/onboarding';
import models from '../../../server/models';
import * as utils from '../../utils';

describe('server/lib/onboarding', () => {
  let admins, sandbox, emailLibSendSpy;

  before(() => {
    sandbox = createSandbox();
    emailLibSendSpy = sandbox.spy(emailLib, 'send');
  });

  beforeEach(async () => {
    await utils.resetTestDB();
    admins = await Promise.all([
      models.User.createUserWithCollective({ name: 'test adminUser1', email: 'testadminUser1@gmail.com' }),
      models.User.createUserWithCollective({ name: 'test adminUser2', email: 'testadminUser2@gmail.com' }),
    ]);
  });

  afterEach(() => {
    emailLibSendSpy.resetHistory();
    sandbox.restore();
  });

  it('sends onboarding after 2 days for new organizations', async () => {
    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - 2);
    const org = await models.Collective.create({
      name: 'airbnb',
      slug: 'airbnb',
      isActive: true,
      type: 'ORGANIZATION',
      CreatedByUserId: admins[0].id,
      createdAt,
    });

    await Promise.each(admins, admin =>
      models.Member.create({
        CreatedByUserId: admins[0].id,
        CollectiveId: org.id,
        MemberCollectiveId: admin.CollectiveId,
        role: 'ADMIN',
      }),
    );

    const startsAt = new Date(createdAt);
    startsAt.setHours(0);
    await processOnBoardingTemplate('onboarding.day2', startsAt);
    expect(emailLibSendSpy.firstCall.args[3].from).to.equal('Open Collective <support@opencollective.com>');
    expect(emailLibSendSpy.callCount).to.equal(2);
    admins.map(admin => {
      const emailServiceCall = emailLibSendSpy.args.find(([, email]) => email === admin.email);
      if (!emailServiceCall) {
        throw new Error(`Looks like onboarding email was not sent to ${admin.email}`);
      }

      expect(emailServiceCall[0]).to.equal('onboarding.day2.organization');
      expect(emailServiceCall[1]).to.equal(admin.email);
      expect(emailServiceCall[2].unsubscribeUrl).to.contain(encodeURIComponent(admin.email));
    });
  });

  it('does not send anything if filter returns false', async () => {
    const createdAt = new Date();
    createdAt.setDate(createdAt.getDate() - 2);
    const org = await models.Collective.create({
      name: 'airbnb',
      slug: 'airbnb',
      isActive: true,
      type: 'ORGANIZATION',
      CreatedByUserId: admins[0].id,
      createdAt,
    });

    await Promise.each(admins, admin =>
      models.Member.create({
        CreatedByUserId: admins[0].id,
        CollectiveId: org.id,
        MemberCollectiveId: admin.CollectiveId,
        role: 'ADMIN',
      }),
    );

    const startsAt = new Date(createdAt);
    startsAt.setHours(0);
    await processOnBoardingTemplate('onboarding.day2', startsAt, () => Promise.resolve(false));
    expect(emailLibSendSpy.callCount).to.equal(0);
  });
});
