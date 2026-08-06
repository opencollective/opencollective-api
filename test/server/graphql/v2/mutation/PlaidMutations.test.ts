import { expect } from 'chai';
import gql from 'fake-tag';
import { PlaidApi } from 'plaid';
import sinon from 'sinon';

import PlatformConstants from '../../../../../server/constants/platform';
import * as PlaidClient from '../../../../../server/lib/plaid/client';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import models, { ConnectedAccount } from '../../../../../server/models';
import { plaidItemPublicTokenExchangeResponse, plaidLinkTokenCreateResponse } from '../../../../mocks/plaid';
import { fakeActiveHost, fakeCollective, fakePlatformSubscription, fakeUser } from '../../../../test-helpers/fake-data';
import { generateValid2FAHeader, graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/PlaidMutations', () => {
  let platform;
  let sandbox: sinon.SinonSandbox;
  let stubPlaidAPI: sinon.SinonStubbedInstance<PlaidApi>;

  const GENERATE_PLAID_LINK_TOKEN_MUTATION = gql`
    mutation GeneratePlaidLinkToken($host: AccountReferenceInput!) {
      generatePlaidLinkToken(host: $host) {
        linkToken
        expiration
        requestId
      }
    }
  `;

  const CONNECT_PLAID_ACCOUNT_MUTATION = gql`
    mutation ConnectPlaidAccount(
      $publicToken: String!
      $linkToken: String!
      $host: AccountReferenceInput!
      $sourceName: String
      $name: String
    ) {
      connectPlaidAccount(
        publicToken: $publicToken
        linkToken: $linkToken
        host: $host
        sourceName: $sourceName
        name: $name
      ) {
        connectedAccount {
          id
          service
        }
        transactionsImport {
          id
          type
          lastSyncAt
        }
      }
    }
  `;

  before(async () => {
    sandbox = sinon.createSandbox();

    // Create platform profile if needed to make sure we can have root users
    platform = await models.Collective.findByPk(PlatformConstants.PlatformCollectiveId);
    if (!platform) {
      platform = await fakeCollective({ id: PlatformConstants.PlatformCollectiveId });
    }
  });

  beforeEach(async () => {
    // Stub plaid
    stubPlaidAPI = sandbox.createStubInstance(PlaidApi);
    stubPlaidAPI.linkTokenCreate = sandbox.stub().resolves(plaidLinkTokenCreateResponse);
    stubPlaidAPI.itemPublicTokenExchange = sandbox.stub().resolves(plaidItemPublicTokenExchangeResponse);
    sandbox.stub(PlaidClient, 'getPlaidClient').returns(stubPlaidAPI);
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('generatePlaidLinkToken', () => {
    it('must be the member of a 1st party host or platform', async () => {
      const remoteUser = await fakeUser();
      const host = await fakeActiveHost({ admin: remoteUser });
      const result = await graphqlQueryV2(
        GENERATE_PLAID_LINK_TOKEN_MUTATION,
        { host: { legacyId: host.id } },
        remoteUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Off-platform transactions are not enabled for this account');
    });

    it('should generate a Plaid Link token', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const host = await fakeActiveHost({ admin: remoteUser });
      await fakePlatformSubscription({
        CollectiveId: host.id,
        plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
      });
      await platform.addUserWithRole(remoteUser, 'ADMIN');
      const result = await graphqlQueryV2(
        GENERATE_PLAID_LINK_TOKEN_MUTATION,
        { host: { legacyId: host.id } },
        remoteUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const tokenResponse = result.data.generatePlaidLinkToken;
      expect(tokenResponse).to.deep.equal({
        linkToken: 'valid-link-token',
        expiration: '2075-01-01T00:00:00Z',
        requestId: 'valid-request-id',
      });
      expect(stubPlaidAPI.linkTokenCreate).to.have.been.calledOnce;
      expect(stubPlaidAPI.linkTokenCreate).to.have.been.calledOnceWith({
        /* eslint-disable camelcase */
        user: { client_user_id: remoteUser.id.toString() },
        client_name: 'Open Collective',
        language: 'en',
        products: ['auth', 'transactions'],
        country_codes: ['US'],
        webhook: 'http://localhost:3060/webhooks/plaid',
        redirect_uri: 'http://localhost:3000/services/plaid/oauth/callback',
        /* eslint-enable camelcase */
      });
    });
  });

  describe('connectPlaidAccount', () => {
    it('must be the member of a 1st party host or platform', async () => {
      const remoteUser = await fakeUser();
      const result = await graphqlQueryV2(
        CONNECT_PLAID_ACCOUNT_MUTATION,
        { publicToken: 'public-sandbox-valid', linkToken: 'irrelevant-link-token', host: { legacyId: 1 } },
        remoteUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You do not have permission to connect a Plaid account');
    });

    it('should connect a Plaid account', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const host = await fakeActiveHost({ admin: remoteUser });
      await platform.addUserWithRole(remoteUser, 'ADMIN');
      await fakePlatformSubscription({
        CollectiveId: host.id,
        plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
      });

      const linkResult = await graphqlQueryV2(
        GENERATE_PLAID_LINK_TOKEN_MUTATION,
        { host: { legacyId: host.id } },
        remoteUser,
      );
      linkResult.errors && console.error(linkResult.errors);
      expect(linkResult.errors).to.not.exist;
      const linkToken = linkResult.data.generatePlaidLinkToken.linkToken;

      const result = await graphqlQueryV2(
        CONNECT_PLAID_ACCOUNT_MUTATION,
        {
          publicToken: 'public-sandbox-valid',
          linkToken,
          host: { legacyId: host.id },
          sourceName: 'Test Bank',
          name: 'Test Account',
        },
        remoteUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.containSubset({
        connectPlaidAccount: {
          connectedAccount: { service: 'plaid' },
          transactionsImport: { type: 'PLAID', lastSyncAt: null },
        },
      });

      expect(stubPlaidAPI.itemPublicTokenExchange).to.have.been.calledOnce;
      expect(stubPlaidAPI.itemPublicTokenExchange).to.have.been.calledOnceWith({
        /* eslint-disable camelcase */
        public_token: 'public-sandbox-valid',
        /* eslint-enable camelcase */
      });
    });

    it('requires 2FA even when the admin has a session that does not have a fresh token', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } }, {}, { enable2FA: true });
      const host = await fakeActiveHost({ admin: remoteUser });
      await platform.addUserWithRole(remoteUser, 'ADMIN');
      await fakePlatformSubscription({
        CollectiveId: host.id,
        plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
      });

      const twoFAHeaders = { [TwoFactorAuthenticationHeader]: generateValid2FAHeader(remoteUser) };

      const linkResult = await graphqlQueryV2(
        GENERATE_PLAID_LINK_TOKEN_MUTATION,
        { host: { legacyId: host.id } },
        remoteUser,
        null,
        twoFAHeaders,
      );
      linkResult.errors && console.error(linkResult.errors);
      expect(linkResult.errors).to.not.exist;
      const linkToken = linkResult.data.generatePlaidLinkToken.linkToken;

      const variables = {
        publicToken: 'public-sandbox-valid',
        linkToken,
        host: { legacyId: host.id },
        sourceName: 'Test Bank',
        name: 'Test Account',
      };

      const withoutToken = await graphqlQueryV2(CONNECT_PLAID_ACCOUNT_MUTATION, variables, remoteUser);
      expect(withoutToken.errors).to.exist;
      expect(withoutToken.errors[0].extensions.code).to.equal('2FA_REQUIRED');

      const withToken = await graphqlQueryV2(CONNECT_PLAID_ACCOUNT_MUTATION, variables, remoteUser, null, twoFAHeaders);
      withToken.errors && console.error(withToken.errors);
      expect(withToken.errors).to.not.exist;
    });
  });

  describe('OAuth session binding', () => {
    /** Creates a host with the OFF_PLATFORM_TRANSACTIONS feature enabled and an admin able to use Plaid */
    const fakePlaidHost = async () => {
      const admin = await fakeUser({ data: { isRoot: true } });
      const host = await fakeActiveHost({ admin });
      await fakePlatformSubscription({
        CollectiveId: host.id,
        plan: { features: { OFF_PLATFORM_TRANSACTIONS: true } },
      });
      await platform.addUserWithRole(admin, 'ADMIN');
      return { admin, host };
    };

    /** Runs `generatePlaidLinkToken` as `admin` for `host` */
    const generateLinkToken = (admin, host) =>
      graphqlQueryV2(GENERATE_PLAID_LINK_TOKEN_MUTATION, { host: { legacyId: host.id } }, admin);

    /** Runs `connectPlaidAccount` as `admin` for `host` */
    const connectAccount = (admin, host, linkToken: string) =>
      graphqlQueryV2(
        CONNECT_PLAID_ACCOUNT_MUTATION,
        {
          publicToken: 'public-sandbox-valid',
          linkToken,
          host: { legacyId: host.id },
          sourceName: 'Test Bank',
          name: 'Test Account',
        },
        admin,
      );

    beforeEach(() => {
      // The public token itself carries no information about which link token generated it: give each
      // call to `linkTokenCreate` a unique token so tests can't accidentally share a cached session.
      let linkTokenCounter = 0;
      /* eslint-disable camelcase */
      stubPlaidAPI.linkTokenCreate = sandbox.stub().callsFake(async () => ({
        status: 200,
        statusText: 'OK',
        data: {
          link_token: `link-token-${++linkTokenCounter}`,
          expiration: '2075-01-01T00:00:00Z',
          request_id: `request-id-${linkTokenCounter}`,
        },
      }));
      /* eslint-enable camelcase */
    });

    it('does not let another host admin claim a link token they did not initiate', async () => {
      // Host A's admin generates a Plaid Link token and completes the Link flow
      const { admin: victimAdmin, host: victimHost } = await fakePlaidHost();
      const linkResult = await generateLinkToken(victimAdmin, victimHost);
      linkResult.errors && console.error(linkResult.errors);
      expect(linkResult.errors).to.not.exist;
      const linkToken = linkResult.data.generatePlaidLinkToken.linkToken;

      // Host B's admin (a legitimate admin of their own host) somehow gets hold of the resulting public
      // token (e.g. by intercepting it) and tries to bind it to their own host using the same link token
      const { admin: attackerAdmin, host: attackerHost } = await fakePlaidHost();
      const attackResult = await connectAccount(attackerAdmin, attackerHost, linkToken);

      expect(attackResult.errors).to.exist;
      expect(attackResult.errors[0].message).to.equal(
        'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
      );

      // Nothing must have been created for the attacker
      expect(await ConnectedAccount.count({ where: { CollectiveId: attackerHost.id } })).to.equal(0);

      // And the victim must still be able to complete their own flow
      const victimResult = await connectAccount(victimAdmin, victimHost, linkToken);
      victimResult.errors && console.error(victimResult.errors);
      expect(victimResult.errors).to.not.exist;
      expect(await ConnectedAccount.count({ where: { CollectiveId: victimHost.id } })).to.equal(1);
    });

    it('lets the initiating admin connect the link token they created', async () => {
      const { admin, host } = await fakePlaidHost();
      const linkResult = await generateLinkToken(admin, host);
      linkResult.errors && console.error(linkResult.errors);
      expect(linkResult.errors).to.not.exist;
      const linkToken = linkResult.data.generatePlaidLinkToken.linkToken;

      const result = await connectAccount(admin, host, linkToken);

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.connectPlaidAccount.connectedAccount).to.exist;
      expect(result.data.connectPlaidAccount.transactionsImport).to.exist;
    });

    it('rejects a link token that was never generated through the platform', async () => {
      const { admin, host } = await fakePlaidHost();
      const result = await connectAccount(admin, host, 'a-link-token-we-never-generated');

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'This bank connection request could not be verified. Please restart the connection process from your dashboard.',
      );
      expect(await ConnectedAccount.count({ where: { CollectiveId: host.id } })).to.equal(0);
    });
  });
});
