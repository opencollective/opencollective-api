import { expect } from 'chai';
import gql from 'fake-tag';
import { PlaidApi } from 'plaid';
import sinon from 'sinon';

import PlatformConstants from '../../../../../server/constants/platform';
import * as PlaidClient from '../../../../../server/lib/plaid/client';
import models from '../../../../../server/models';
import { plaidItemPublicTokenExchangeResponse, plaidLinkTokenCreateResponse } from '../../../../mocks/plaid';
import { fakeActiveHost, fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

describe('server/graphql/v2/mutation/PlaidMutations', () => {
  let platform;
  let sandbox: sinon.SinonSandbox;
  let stubPlaidAPI: sinon.SinonStubbedInstance<PlaidApi>;

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
    const GENERATE_PLAID_LINK_TOKEN_MUTATION = gql`
      mutation GeneratePlaidLinkToken {
        generatePlaidLinkToken {
          linkToken
          expiration
          requestId
        }
      }
    `;

    it('must be root', async () => {
      const remoteUser = await fakeUser();
      const result = await graphqlQueryV2(GENERATE_PLAID_LINK_TOKEN_MUTATION, {}, remoteUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in as root.');
    });

    it('should generate a Plaid Link token', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      await platform.addUserWithRole(remoteUser, 'ADMIN');
      const result = await graphqlQueryV2(GENERATE_PLAID_LINK_TOKEN_MUTATION, {}, remoteUser);
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
        /* eslint-enable camelcase */
      });
    });
  });

  describe('connectPlaidAccount', () => {
    const CONNECT_PLAID_ACCOUNT_MUTATION = gql`
      mutation ConnectPlaidAccount(
        $publicToken: String!
        $host: AccountReferenceInput!
        $sourceName: String
        $name: String
      ) {
        connectPlaidAccount(publicToken: $publicToken, host: $host, sourceName: $sourceName, name: $name) {
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

    it('must be root', async () => {
      const remoteUser = await fakeUser();
      const result = await graphqlQueryV2(
        CONNECT_PLAID_ACCOUNT_MUTATION,
        { publicToken: 'public-sandbox-valid', host: { legacyId: 1 } },
        remoteUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in as root.');
    });

    it('should connect a Plaid account', async () => {
      const remoteUser = await fakeUser({ data: { isRoot: true } });
      const host = await fakeActiveHost({ admin: remoteUser });
      await platform.addUserWithRole(remoteUser, 'ADMIN');
      const result = await graphqlQueryV2(
        CONNECT_PLAID_ACCOUNT_MUTATION,
        {
          publicToken: 'public-sandbox-valid',
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
  });
});
