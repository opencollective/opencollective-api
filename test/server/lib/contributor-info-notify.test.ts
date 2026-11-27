import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import ActivityTypes from '../../../server/constants/activities';
import MemberRoles from '../../../server/constants/roles';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { getYearsToProcess, notifyContributorsMissingInfo } from '../../../server/lib/contributor-info-notify';
import emailLib from '../../../server/lib/email';
import { Activity, sequelize } from '../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeMember,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const YEAR = 2025;

describe('server/lib/contributor-info-notify', () => {
  let sandbox: sinon.SinonSandbox, sendMessage: sinon.SinonStub, host, collective;

  /** A contribution of `amount` (cents) from `profile`, then a refresh of the community views */
  const contribute = async (profile: { id: number }, amount: number) => {
    await fakeTransaction({
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      CollectiveId: collective.id,
      FromCollectiveId: profile.id,
      HostCollectiveId: host.id,
      amount,
      amountInHostCurrency: amount,
      currency: 'USD',
      hostCurrency: 'USD',
      createdAt: new Date(Date.UTC(YEAR, 5, 15)),
    });
    await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityTransactionSummary"');
    await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityHostYearlyTransactionSummary"');
  };

  const run = (options: Partial<Parameters<typeof notifyContributorsMissingInfo>[0]> = {}) =>
    notifyContributorsMissingInfo({ years: [YEAR], dryRun: false, ...options });

  const getActivities = (CollectiveId: number) =>
    Activity.findAll({
      where: { type: ActivityTypes.CONTRIBUTOR_INFO_REQUESTED, CollectiveId },
      order: [['id', 'ASC']],
    });

  const daysFromNow = (days: number) => moment().add(days, 'days').toDate();

  beforeEach(async () => {
    await resetTestDB();
    sandbox = sinon.createSandbox();
    sendMessage = sandbox.stub(emailLib, 'sendMessage').resolves();
    host = await fakeActiveHost({
      currency: 'USD',
      name: 'Tax Host',
      data: { policies: { CONTRIBUTOR_INFO_THRESHOLDS: { legalName: 100e2, address: 500e2 } } },
    });
    collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('emails the contributor once, records the request and dedups the next runs', async () => {
    const user = await fakeUser({ email: 'contributor@example.com' }, { name: 'Jane' });
    await contribute(user.collective, 200e2);

    const report = await run();
    expect(report.profiles).to.containSubset([{ profileId: user.collective.id, status: 'sent', recipients: 1 }]);
    expect(report.hosts).to.containSubset([{ hostId: host.id, candidates: 1, requests: 1, sent: 1 }]);
    expect(sendMessage.callCount).to.equal(1);
    const [to, subject, html] = sendMessage.firstCall.args;
    expect(to).to.equal('contributor@example.com');
    expect(subject).to.include('Action required');
    // Individuals get a slug-independent link: the slug of a guest changes on its first login
    expect(html).to.include('Tax Host').and.to.include('legal name').and.to.include('/dashboard/me/info');

    const activities = await getActivities(user.collective.id);
    expect(activities).to.have.length(1);
    expect(activities[0].UserId).to.equal(user.id);
    expect(activities[0].data).to.containSubset({
      notify: false,
      isReminder: false,
      hosts: [{ id: host.id, year: YEAR, missingFields: ['legalName'], isReminder: false }],
    });

    const secondReport = await run();
    expect(secondReport.profiles).to.containSubset([{ profileId: user.collective.id, status: 'deduped' }]);
    expect(sendMessage.callCount).to.equal(1);
  });

  it('sends one reminder per request, and a new request when more fields are missing', async () => {
    const user = await fakeUser();
    await contribute(user.collective, 200e2);
    await run();

    // Too early for a reminder
    expect((await run({ now: daysFromNow(29) })).profiles[0].status).to.equal('deduped');

    // Reminder due
    const reminderReport = await run({ now: daysFromNow(31) });
    expect(reminderReport.profiles[0]).to.containSubset({ status: 'sent', isReminder: true });
    expect(sendMessage.secondCall.args[1]).to.include('Reminder');

    // Only one reminder per request
    expect((await run({ now: daysFromNow(90) })).profiles[0].status).to.equal('deduped');

    // The address is now missing too: new request, then its own reminder
    await contribute(user.collective, 400e2);
    const growthReport = await run();
    expect(growthReport.profiles[0]).to.containSubset({ status: 'sent', isReminder: false });
    expect((await run({ now: daysFromNow(31) })).profiles[0]).to.containSubset({ status: 'sent', isReminder: true });

    const activities = await getActivities(user.collective.id);
    expect(activities.map(a => a.data.hosts[0].missingFields)).to.deep.equal([
      ['legalName'],
      ['legalName'],
      ['legalName', 'address'],
      ['legalName', 'address'],
    ]);
    expect(activities.map(a => a.data.isReminder)).to.deep.equal([false, true, false, true]);
  });

  it('emails every admin of an organization and records a single activity', async () => {
    const organization = await fakeOrganization({ name: 'ACME' });
    const admins = await Promise.all([fakeUser(), fakeUser()]);
    for (const admin of admins) {
      await fakeMember({
        CollectiveId: organization.id,
        MemberCollectiveId: admin.collective.id,
        role: MemberRoles.ADMIN,
      });
    }
    await contribute(organization, 200e2);

    const report = await run();
    expect(report.profiles[0]).to.containSubset({ status: 'sent', recipients: 2 });
    expect(sendMessage.args.map(args => args[0])).to.have.members(admins.map(a => a.email));
    expect(sendMessage.firstCall.args[1]).to.include("ACME's");
    expect(await getActivities(organization.id)).to.have.length(1);
  });

  it('does not send or record anything in dry run', async () => {
    const user = await fakeUser();
    await contribute(user.collective, 200e2);

    const report = await run({ dryRun: true });
    expect(report.profiles[0]).to.containSubset({ status: 'wouldSend', recipients: 1 });
    expect(sendMessage.called).to.be.false;
    expect(await getActivities(user.collective.id)).to.be.empty;
  });

  it('stops at the recipient limit without splitting a profile, except the first one', async () => {
    const organization = await fakeOrganization();
    for (const admin of await Promise.all([fakeUser(), fakeUser()])) {
      await fakeMember({
        CollectiveId: organization.id,
        MemberCollectiveId: admin.collective.id,
        role: MemberRoles.ADMIN,
      });
    }
    await contribute(organization, 300e2);
    const user = await fakeUser();
    await contribute(user.collective, 200e2);

    const report = await run({ limit: 1 });
    expect(report.recipients).to.equal(2);
    expect(report.profiles).to.containSubset([
      { profileId: organization.id, status: 'sent' },
      { profileId: user.collective.id, status: 'leftOver' },
    ]);
    expect(report.hosts).to.containSubset([{ hostId: host.id, sent: 1, leftOver: 1 }]);
    expect(await getActivities(user.collective.id)).to.be.empty;

    // Left over profiles are picked up by the next run
    expect((await run({ limit: 1 })).profiles).to.containSubset([{ profileId: user.collective.id, status: 'sent' }]);
  });

  it('records nothing when the email fails, so the next run retries', async () => {
    const user = await fakeUser();
    await contribute(user.collective, 200e2);
    sendMessage.rejects(new Error('SMTP down'));

    expect((await run()).profiles[0].status).to.equal('failed');
    expect(await getActivities(user.collective.id)).to.be.empty;

    sendMessage.resolves();
    expect((await run()).profiles[0].status).to.equal('sent');
  });

  it('ignores earlier requests with ignoreDedup', async () => {
    const user = await fakeUser();
    await contribute(user.collective, 200e2);
    await run();

    expect((await run({ profileIds: [user.collective.id], ignoreDedup: true })).profiles[0].status).to.equal('sent');
    expect(await getActivities(user.collective.id)).to.have.length(2);
  });

  it('getYearsToProcess: includes the previous year during the first 90 days', () => {
    expect(getYearsToProcess(new Date(Date.UTC(2026, 2, 31)))).to.deep.equal([2026, 2025]);
    expect(getYearsToProcess(new Date(Date.UTC(2026, 3, 1)))).to.deep.equal([2026]);
  });
});
