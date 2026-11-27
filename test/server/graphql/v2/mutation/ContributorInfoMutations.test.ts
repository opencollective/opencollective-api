import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import ActivityTypes from '../../../../../server/constants/activities';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { sanitizeActivityData } from '../../../../../server/graphql/common/activities';
import {
  getPendingContributorInfoRequest,
  notifyContributorsMissingInfo,
} from '../../../../../server/lib/contributor-info-notify';
import emailLib from '../../../../../server/lib/email';
import { Activity, sequelize } from '../../../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

type SanitizeRequest = Parameters<typeof sanitizeActivityData>[0];

const REQUEST_MUTATION = gql`
  mutation RequestContributorInfo($input: RequestContributorInfoInput!) {
    requestContributorInfo(input: $input)
  }
`;

const PENDING_REQUEST_QUERY = gql`
  query PendingContributorInfoRequest($account: String!, $host: AccountReferenceInput!) {
    account(id: $account) {
      communityStats(host: $host) {
        pendingContributorInfoRequest {
          requestedAt
          fields
          addressFields
        }
      }
    }
  }
`;

describe('server/graphql/v2/mutation/ContributorInfoMutations', () => {
  const sandbox = createSandbox();
  let host, hostAdmin, collective, sendMessage;

  const contribute = (fromCollectiveId: number, amount = 300e2) =>
    fakeTransaction({
      type: 'CREDIT',
      kind: TransactionKind.CONTRIBUTION,
      CollectiveId: collective.id,
      FromCollectiveId: fromCollectiveId,
      HostCollectiveId: host.id,
      amount,
      amountInHostCurrency: amount,
      currency: 'USD',
      hostCurrency: 'USD',
    });

  const request = (account, input = {}, remoteUser = hostAdmin) =>
    graphqlQueryV2(
      REQUEST_MUTATION,
      { input: { host: { legacyId: host.id }, account: { legacyId: account.id }, fields: ['LEGAL_NAME'], ...input } },
      remoteUser,
    );

  before(async () => {
    await resetTestDB();
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ admin: hostAdmin, currency: 'USD' }); // Default USD thresholds: $250 legal name
    collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
  });

  beforeEach(() => {
    sendMessage = sandbox.stub(emailLib, 'sendMessage').resolves();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('only allows host admins', async () => {
    const user = await fakeUser();
    await contribute(user.collective.id);
    const result = await request(user.collective, {}, await fakeUser());
    expect(result.errors[0].message).to.equal('Only host admins can request contributor information');
    expect(sendMessage.called).to.be.false;
  });

  it('only allows accounts with a transaction under the host', async () => {
    const user = await fakeUser();
    const result = await request(user.collective);
    expect(result.errors[0].message).to.equal('This account has no transactions with your fiscal host');

    const result2 = await request(collective);
    expect(result2.errors[0].message).to.equal('Information can only be requested from individuals and organizations');
  });

  it('validates the input', async () => {
    const user = await fakeUser();
    await contribute(user.collective.id);
    expect((await request(user.collective, { fields: [] })).errors[0].message).to.equal(
      'Select at least one field to request',
    );
    expect((await request(user.collective, { addressFields: ['CITY'] })).errors[0].message).to.equal(
      'Address fields can only be requested with the address',
    );
    expect((await request(user.collective, { message: 'a'.repeat(1001) })).errors[0].message).to.equal(
      'Message is too long (maximum 1000 characters)',
    );
    expect(sendMessage.called).to.be.false;
  });

  it('emails the account with the fields and the message, records the request and rate limits it', async () => {
    const user = await fakeUser();
    await contribute(user.collective.id);
    const result = await request(user.collective, {
      fields: ['LEGAL_NAME', 'ADDRESS'],
      addressFields: ['POSTAL_CODE', 'CITY'],
      message: '  Please use your <b>full</b> name  ',
    });
    result.errors && console.error(result.errors);
    expect(result.data.requestContributorInfo).to.be.true;

    expect(sendMessage.callCount).to.equal(1);
    const [to, subject, html] = sendMessage.firstCall.args;
    expect(to).to.equal(user.email);
    expect(subject).to.equal(`${host.name} asks you to update your Open Collective profile`);
    expect(html).to.match(/<li[^>]*>Legal name<\/li>/);
    expect(html).to.match(/<li[^>]*>Address: postal code, city<\/li>/);
    expect(html).to.include('Please use your &lt;b&gt;full&lt;/b&gt; name');
    expect(html).to.include('/dashboard/me/info');

    const activity = await Activity.findOne({
      where: { type: ActivityTypes.CONTRIBUTOR_INFO_REQUESTED, CollectiveId: user.collective.id },
    });
    expect(activity.HostCollectiveId).to.equal(host.id);
    expect(activity.UserId).to.equal(hostAdmin.id);
    expect(activity.data).to.deep.include({
      notify: false,
      isManual: true,
      isReminder: false,
      message: 'Please use your <b>full</b> name',
      recipientIds: [user.id],
    });
    expect(activity.data.hosts).to.deep.equal([
      {
        id: host.id,
        slug: host.slug,
        name: host.name,
        year: new Date().getUTCFullYear(),
        missingFields: ['legalName', 'address'],
        isReminder: false,
        addressParts: ['postalCode', 'city'],
      },
    ]);

    // Host admins see what was requested, others do not
    const hostAdminData = await sanitizeActivityData({ remoteUser: hostAdmin } as unknown as SanitizeRequest, activity);
    expect(hostAdminData).to.have.property('message');
    expect(await sanitizeActivityData({ remoteUser: await fakeUser() } as unknown as SanitizeRequest, activity)).to.eql(
      {},
    );

    const secondResult = await request(user.collective);
    expect(secondResult.errors[0].message).to.equal(
      'Information was already requested from this account in the last 24 hours',
    );
    expect(sendMessage.callCount).to.equal(1);
  });

  it('emails each admin of an organization', async () => {
    const admins = [await fakeUser(), await fakeUser()];
    const organization = await fakeOrganization({ admin: admins[0] });
    await organization.addUserWithRole(admins[1], 'ADMIN');
    await contribute(organization.id, 100e2);
    const result = await request(organization);
    result.errors && console.error(result.errors);
    expect(result.data.requestContributorInfo).to.be.true;
    expect(sendMessage.args.map(args => args[0])).to.have.members(admins.map(u => u.email));
    expect(sendMessage.firstCall.args[2]).to.include(`/dashboard/${organization.slug}/info`);
    expect(sendMessage.firstCall.args[1]).to.equal(
      `${host.name} asks you to update ${organization.name}'s Open Collective profile`,
    );
  });

  it('counts as a request for the daily job', async () => {
    const user = await fakeUser();
    await contribute(user.collective.id);
    await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityTransactionSummary"');
    await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityHostYearlyTransactionSummary"');
    expect((await request(user.collective)).data.requestContributorInfo).to.be.true;

    const report = await notifyContributorsMissingInfo({
      years: [new Date().getUTCFullYear()],
      profileIds: [user.collective.id],
      dryRun: true,
    });
    expect(report.profiles.map(p => p.status)).to.deep.equal(['deduped']);
  });

  describe('pending requests', () => {
    it('reports the manually requested values until they change', async () => {
      const user = await fakeUser({}, { legalName: 'Robert Smith' });
      await user.collective.setLocation({
        country: 'US',
        structured: { address1: '1 Main St', city: 'Springfield', postalCode: '62701', zone: 'IL' },
      });
      await contribute(user.collective.id);
      await request(user.collective, { fields: ['LEGAL_NAME', 'ADDRESS'], addressFields: ['POSTAL_CODE', 'CITY'] });

      // `communityStats` needs the account in the host community (contributors are BACKER members)
      await collective.addUserWithRole(user, 'BACKER');
      await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityActivitySummary"');
      const result = await graphqlQueryV2(
        PENDING_REQUEST_QUERY,
        { account: user.collective.publicId, host: { legacyId: host.id } },
        hostAdmin,
      );
      result.errors && console.error(result.errors);
      const pending = result.data.account.communityStats.pendingContributorInfoRequest;
      expect(pending.fields).to.have.members(['LEGAL_NAME', 'ADDRESS']);
      expect(pending.addressFields).to.have.members(['POSTAL_CODE', 'CITY']);

      // Unchanged values stay pending, changed ones are fulfilled
      await user.collective.setLocation({
        country: 'US',
        structured: { address1: '1 Main St', city: 'Shelbyville', postalCode: '62701', zone: 'IL' },
      });
      let lib = await getPendingContributorInfoRequest({ host, profile: await user.collective.reload() });
      expect(lib.fields).to.have.members(['legalName', 'address']);
      expect(lib.addressParts).to.deep.equal(['postalCode']);

      await user.collective.update({ legalName: 'Robert J. Smith' });
      await user.collective.setLocation({
        country: 'US',
        structured: { address1: '1 Main St', city: 'Shelbyville', postalCode: '62702', zone: 'IL' },
      });
      lib = await getPendingContributorInfoRequest({ host, profile: await user.collective.reload() });
      expect(lib).to.be.null;
    });

    it('compares the whole address when no part was selected', async () => {
      const user = await fakeUser();
      await user.collective.setLocation({ country: 'FR', address: '1 rue de Paris' });
      await contribute(user.collective.id);
      await request(user.collective, { fields: ['ADDRESS'] });

      let pending = await getPendingContributorInfoRequest({ host, profile: user.collective });
      expect(pending).to.deep.include({ fields: ['address'], addressParts: [] });

      await user.collective.setLocation({ country: 'FR', address: '2 rue de Paris' });
      pending = await getPendingContributorInfoRequest({ host, profile: user.collective });
      expect(pending).to.be.null;
    });

    it('reports automatic requests while the information is missing', async () => {
      const user = await fakeUser();
      await contribute(user.collective.id);
      await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityTransactionSummary"');
      await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityHostYearlyTransactionSummary"');
      await notifyContributorsMissingInfo({
        years: [new Date().getUTCFullYear()],
        profileIds: [user.collective.id],
        dryRun: false,
      });

      let pending = await getPendingContributorInfoRequest({ host, profile: user.collective });
      expect(pending.fields).to.deep.equal(['legalName']);

      await user.collective.update({ legalName: 'Robert Smith' });
      pending = await getPendingContributorInfoRequest({ host, profile: user.collective });
      expect(pending).to.be.null;

      const otherHost = await fakeActiveHost();
      expect(await getPendingContributorInfoRequest({ host: otherHost, profile: user.collective })).to.be.null;
    });
  });
});
