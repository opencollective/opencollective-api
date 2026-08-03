/* eslint-disable camelcase */
import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import * as GoCardlessClient from '../../../../../server/lib/gocardless/client';
import * as GoCardlessSync from '../../../../../server/lib/gocardless/sync';
import { GoCardlessRequisitionStatus } from '../../../../../server/lib/gocardless/types';
import RateLimit from '../../../../../server/lib/rate-limit';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import { ConnectedAccount, User } from '../../../../../server/models';
import { fakeActiveHost, fakePlatformSubscription, fakeUser, randStr } from '../../../../test-helpers/fake-data';
import { generateValid2FAHeader, graphqlQueryV2, resetTestDB } from '../../../../utils';

const GENERATE_GOCARDLESS_LINK_MUTATION = gql`
  mutation GenerateGoCardlessLink($input: GoCardlessLinkInput!, $host: AccountReferenceInput!) {
    generateGoCardlessLink(input: $input, host: $host) {
      id
      institutionId
      link
    }
  }
`;

const CONNECT_GOCARDLESS_ACCOUNT_MUTATION = gql`
  mutation ConnectGoCardlessAccount($requisitionId: String!, $host: AccountReferenceInput!) {
    connectGoCardlessAccount(requisitionId: $requisitionId, host: $host) {
      connectedAccount {
        id
        legacyId
      }
      transactionsImport {
        id
      }
    }
  }
`;

const institution = {
  id: 'BOURSORAMA_BOUSFRPP',
  max_access_valid_for_days: '180',
  transaction_total_days: '90',
  name: 'Boursorama',
};

const accountMetadata = {
  id: '28ccfcf2-xxxx-xxxx-xxxx-4a27xxxxxxxx',
  iban: 'FR76300010079412345678xxxxxxxx',
  name: 'Test Account',
  institution_id: institution.id,
};

/**
 * Rate limits are stored in Redis, which is not reset by `resetTestDB`. Since the test DB restarts
 * identities, user IDs are recycled across test files: we need to explicitly reset the limits.
 */
const resetGoCardlessRateLimits = async (user: User) => {
  await new RateLimit(`generateGoCardlessLink:${user.id}`, 20, 60 * 60).reset();
  await new RateLimit(`connectGoCardlessAccount:${user.id}`, 20, 60 * 60).reset();
};

/** Creates a host with the OFF_PLATFORM_TRANSACTIONS feature enabled and an admin able to use GoCardless */
const fakeOffPlatformTransactionsHost = async ({ enable2FA = false } = {}) => {
  const admin = await fakeUser({}, {}, { enable2FA });
  const host = await fakeActiveHost({ admin });
  await fakePlatformSubscription({
    CollectiveId: host.id,
    plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
  });
  await resetGoCardlessRateLimits(admin);
  return { admin, host };
};

describe('server/graphql/v2/mutation/GoCardlessMutations', () => {
  const sandbox = createSandbox();
  let createRequisitionStub;

  beforeEach(async () => {
    await resetTestDB();

    // The requisition returned by `createRequisition` is the one the end user is redirected to their
    // bank for. We give it a unique ID per call so that tests can't accidentally share state.
    createRequisitionStub = sandbox.stub().callsFake(async () => ({
      id: randStr('requisition-'),
      status: GoCardlessRequisitionStatus.CR,
      institution_id: institution.id,
      created: '2025-07-10T14:11:27.521655Z',
      link: 'https://ob.gocardless.com/psd2/start/test-id/test-institution',
      redirect: 'http://localhost:3000/services/gocardless/callback',
    }));

    sandbox.stub(GoCardlessClient, 'getGoCardlessClient').returns({
      agreement: {
        createAgreement: sandbox.stub().resolves({ id: 'agreement-id' }),
      },
      requisition: {
        createRequisition: createRequisitionStub,
        // Once the end user comes back from their bank, the requisition is `LINKED` with accounts
        getRequisitionById: sandbox.stub().callsFake(async (requisitionId: string) => ({
          id: requisitionId,
          status: GoCardlessRequisitionStatus.LN,
          institution_id: institution.id,
          created: '2025-07-10T14:11:27.521655Z',
          accounts: [accountMetadata.id],
        })),
      },
      institution: {
        getInstitutionById: sandbox.stub().resolves(institution),
      },
      account: sandbox.stub().callsFake(() => ({
        getMetadata: sandbox.stub().resolves(accountMetadata),
      })),
    } as never);

    sandbox.stub(GoCardlessClient, 'getOrRefreshGoCardlessToken').resolves();
    sandbox.stub(GoCardlessSync, 'syncGoCardlessAccount').resolves();
  });

  afterEach(() => sandbox.restore());

  /**
   * 2FA sessions are cached per (user, JWT session ID) pair, and the test DB restarts identities on
   * every reset: always use a fresh session ID so that tests can't inherit a 2FA session from another
   * test (or from a previous run, since Redis is not reset).
   */
  const newSession = () => ({ sessionId: randStr('session-') });

  /** Runs `generateGoCardlessLink` as `admin` for `host` */
  const generateLink = (admin: User, host, { headers = {}, jwtPayload = newSession() } = {}) =>
    graphqlQueryV2(
      GENERATE_GOCARDLESS_LINK_MUTATION,
      { host: { legacyId: host.id }, input: { institutionId: institution.id } },
      admin,
      jwtPayload,
      headers,
    );

  /** Runs `connectGoCardlessAccount` as `admin` for `host` */
  const connectAccount = (admin: User, host, requisitionId: string, { headers = {}, jwtPayload = newSession() } = {}) =>
    graphqlQueryV2(
      CONNECT_GOCARDLESS_ACCOUNT_MUTATION,
      { requisitionId, host: { legacyId: host.id } },
      admin,
      jwtPayload,
      headers,
    );

  describe('OAuth session binding', () => {
    it('does not let another host admin claim a requisition they did not initiate', async () => {
      // Host A's admin initiates the GoCardless flow
      const { admin: victimAdmin, host: victimHost } = await fakeOffPlatformTransactionsHost();
      const linkResult = await generateLink(victimAdmin, victimHost);
      linkResult.errors && console.error(linkResult.errors);
      expect(linkResult.errors).to.not.exist;
      const requisitionId = linkResult.data.generateGoCardlessLink.id;

      // Host B's admin (a legitimate admin of their own host, with off-platform transactions enabled)
      // captures the requisition ID from the OAuth redirect and tries to bind it to their own host
      const { admin: attackerAdmin, host: attackerHost } = await fakeOffPlatformTransactionsHost();
      const attackResult = await connectAccount(attackerAdmin, attackerHost, requisitionId);

      expect(attackResult.errors).to.exist;
      expect(attackResult.errors[0].message).to.equal(
        'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
      );

      // Nothing must have been created for the attacker
      expect(await ConnectedAccount.count({ where: { CollectiveId: attackerHost.id } })).to.equal(0);

      // And the victim must still be able to complete their own flow
      const victimResult = await connectAccount(victimAdmin, victimHost, requisitionId);
      victimResult.errors && console.error(victimResult.errors);
      expect(victimResult.errors).to.not.exist;
      expect(await ConnectedAccount.count({ where: { CollectiveId: victimHost.id } })).to.equal(1);
    });

    it('lets the initiating admin connect the requisition they created', async () => {
      const { admin, host } = await fakeOffPlatformTransactionsHost();
      const linkResult = await generateLink(admin, host);
      linkResult.errors && console.error(linkResult.errors);
      expect(linkResult.errors).to.not.exist;
      const requisitionId = linkResult.data.generateGoCardlessLink.id;

      const result = await connectAccount(admin, host, requisitionId);

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.connectGoCardlessAccount.connectedAccount).to.exist;
      expect(result.data.connectGoCardlessAccount.transactionsImport).to.exist;

      const connectedAccount = await ConnectedAccount.findOne({ where: { CollectiveId: host.id } });
      expect(connectedAccount.clientId).to.equal(requisitionId);
      expect(connectedAccount.CreatedByUserId).to.equal(admin.id);
    });

    it('rejects a requisition that was never initiated through the platform', async () => {
      const { admin, host } = await fakeOffPlatformTransactionsHost();
      const result = await connectAccount(admin, host, 'a-requisition-id-we-never-created');

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
      );
      expect(await ConnectedAccount.count()).to.equal(0);
    });
  });

  describe('two-factor authentication', () => {
    it('requires 2FA to generate a link when the admin has it enabled', async () => {
      const { admin, host } = await fakeOffPlatformTransactionsHost({ enable2FA: true });

      const withoutToken = await generateLink(admin, host);
      expect(withoutToken.errors).to.exist;
      expect(withoutToken.errors[0].extensions.code).to.equal('2FA_REQUIRED');

      const withToken = await generateLink(admin, host, {
        headers: { [TwoFactorAuthenticationHeader]: generateValid2FAHeader(admin) },
      });
      withToken.errors && console.error(withToken.errors);
      expect(withToken.errors).to.not.exist;
      expect(withToken.data.generateGoCardlessLink.id).to.exist;
    });

    it('requires 2FA to connect an account when the admin has it enabled', async () => {
      const { admin, host } = await fakeOffPlatformTransactionsHost({ enable2FA: true });
      const linkResult = await generateLink(admin, host, {
        headers: { [TwoFactorAuthenticationHeader]: generateValid2FAHeader(admin) },
      });
      linkResult.errors && console.error(linkResult.errors);
      expect(linkResult.errors).to.not.exist;
      const requisitionId = linkResult.data.generateGoCardlessLink.id;

      // Coming back from the bank in a session that has not validated 2FA yet
      const connectSession = newSession();
      const withoutToken = await connectAccount(admin, host, requisitionId, { jwtPayload: connectSession });
      expect(withoutToken.errors).to.exist;
      expect(withoutToken.errors[0].extensions.code).to.equal('2FA_REQUIRED');
      expect(await ConnectedAccount.count()).to.equal(0);

      const withToken = await connectAccount(admin, host, requisitionId, {
        jwtPayload: connectSession,
        headers: { [TwoFactorAuthenticationHeader]: generateValid2FAHeader(admin) },
      });
      withToken.errors && console.error(withToken.errors);
      expect(withToken.errors).to.not.exist;
      expect(await ConnectedAccount.count({ where: { CollectiveId: host.id } })).to.equal(1);
    });
  });

  // Make sure the new checks don't shadow the pre-existing authorization checks
  describe('permissions', () => {
    it('rejects non-admins', async () => {
      const { host } = await fakeOffPlatformTransactionsHost();
      const randomUser = await fakeUser();
      await resetGoCardlessRateLimits(randomUser);

      const result = await generateLink(randomUser, host);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You do not have permission to generate a GoCardless link');
    });
  });
});
