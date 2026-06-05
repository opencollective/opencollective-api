import { expect } from 'chai';
import gql from 'fake-tag';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { sessionCache } from '../../../../../server/lib/cache';
import * as transferwiseLib from '../../../../../server/lib/transferwise';
import twoFactorAuthLib from '../../../../../server/lib/two-factor-authentication';
import models from '../../../../../server/models';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const CONNECT_TRANSFERWISE_ACCOUNT_MUTATION = gql`
  mutation ConnectTransferwiseAccount($code: NonEmptyString!, $profileId: NonEmptyString!, $state: NonEmptyString!) {
    connectTransferwiseAccount(code: $code, profileId: $profileId, state: $state) {
      connectedAccount {
        id
        service
      }
      redirectUrl
    }
  }
`;

const GET_TRANSFERWISE_OAUTH_URL_MUTATION = gql`
  mutation GetTransferwiseOAuthUrl($account: AccountReferenceInput!, $redirect: String) {
    getTransferwiseOAuthUrl(account: $account, redirect: $redirect)
  }
`;

describe('server/graphql/v2/mutation/TransferwiseMutations', () => {
  const sandbox = createSandbox();

  // The profile that we'll connect. `userId` is the Wise personal profile owner id.
  const personalProfile = { id: 217896, type: 'PERSONAL', userId: 9999 };
  const businessProfile = { id: 220192, type: 'BUSINESS', companyRole: 'OWNER', userId: 9999 };

  let user, host, otherUser;
  let getOrRefreshTokenStub;
  let enforceForAccountStub;

  before(async () => {
    await resetTestDB();
    user = await fakeUser();
    otherUser = await fakeUser();
    host = await fakeCollective({ admin: user, currency: 'EUR' });
    await host.addUserWithRole(user, 'ADMIN');
  });

  beforeEach(() => {
    getOrRefreshTokenStub = sandbox.stub(transferwiseLib, 'getOrRefreshToken').resolves({
      /* eslint-disable camelcase */
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      token_type: 'bearer',
      expires_in: 43199,
      scope: 'transfers',
      created_at: moment().unix(),
      /* eslint-enable camelcase */
    } as any);
    sandbox.stub(transferwiseLib, 'getProfiles').resolves([personalProfile, businessProfile] as any);
    enforceForAccountStub = sandbox.stub(twoFactorAuthLib, 'enforceForAccount').resolves();
  });

  afterEach(() => sandbox.restore());

  describe('getTransferwiseOAuthUrl', () => {
    const VALID_REDIRECT = 'http://localhost:3000/dashboard/host-settings';
    const FAKE_OAUTH_URL =
      'https://wise-sandbox.com/oauth/authorize/?client_id=opencollective&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fservices%2Ftransferwise%2Foauth%2Fcallback&state=abc123';

    let getOAuthUrlStub;

    beforeEach(() => {
      getOAuthUrlStub = sandbox.stub(transferwiseLib, 'getOAuthUrl').returns(FAKE_OAUTH_URL);
    });

    it('throws if the user is not logged in', async () => {
      const result = await graphqlQueryV2(GET_TRANSFERWISE_OAUTH_URL_MUTATION, { account: { slug: host.slug } });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage connected accounts.');
    });

    it('throws if the account does not exist', async () => {
      const result = await graphqlQueryV2(
        GET_TRANSFERWISE_OAUTH_URL_MUTATION,
        { account: { slug: 'non-existent-collective' } },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Account Not Found');
    });

    it('throws if the user is not an admin of the account', async () => {
      const result = await graphqlQueryV2(
        GET_TRANSFERWISE_OAUTH_URL_MUTATION,
        { account: { slug: host.slug } },
        otherUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('must be an admin');
    });

    it('throws if the redirect URL has an invalid origin', async () => {
      const result = await graphqlQueryV2(
        GET_TRANSFERWISE_OAUTH_URL_MUTATION,
        { account: { slug: host.slug }, redirect: 'https://evil.com/steal-token' },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Invalid redirect url');
    });

    it('returns the Wise OAuth URL without a redirect', async () => {
      const result = await graphqlQueryV2(GET_TRANSFERWISE_OAUTH_URL_MUTATION, { account: { slug: host.slug } }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.getTransferwiseOAuthUrl).to.equal(FAKE_OAUTH_URL);
      expect(getOAuthUrlStub.calledOnce).to.be.true;

      // A session cache entry must have been created for the generated state
      const stateArg = getOAuthUrlStub.firstCall.args[0];
      const cached = await sessionCache.get(`transferwise_oauth_${stateArg}`);
      expect(cached).to.exist;
      expect(cached.CollectiveId).to.equal(host.id);
      expect(cached.UserId).to.equal(user.id);
      expect(cached.redirect).to.be.undefined;
    });

    it('returns the Wise OAuth URL with a valid redirect and stores it in the session cache', async () => {
      const result = await graphqlQueryV2(
        GET_TRANSFERWISE_OAUTH_URL_MUTATION,
        { account: { slug: host.slug }, redirect: VALID_REDIRECT },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.getTransferwiseOAuthUrl).to.equal(FAKE_OAUTH_URL);

      // The redirect must be persisted in the session cache alongside the state
      const stateArg = getOAuthUrlStub.firstCall.args[0];
      const cached = await sessionCache.get(`transferwise_oauth_${stateArg}`);
      expect(cached).to.exist;
      expect(cached.redirect).to.equal(VALID_REDIRECT);
      expect(cached.CollectiveId).to.equal(host.id);
      expect(cached.UserId).to.equal(user.id);
    });

    it('enforces two-factor authentication for the account', async () => {
      const result = await graphqlQueryV2(GET_TRANSFERWISE_OAUTH_URL_MUTATION, { account: { slug: host.slug } }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(enforceForAccountStub.calledOnce).to.be.true;
      const [, accountArg] = enforceForAccountStub.firstCall.args;
      expect(accountArg.id).to.equal(host.id);
    });
  });

  describe('connectTransferwiseAccount', () => {
    const setOAuthState = async (state: string, payload: Record<string, unknown>) => {
      await sessionCache.set(`transferwise_oauth_${state}`, payload, 60 * 10);
    };

    it('throws if the user is not logged in', async () => {
      const result = await graphqlQueryV2(CONNECT_TRANSFERWISE_ACCOUNT_MUTATION, {
        code: 'oauth-code',
        profileId: String(businessProfile.id),
        state: 'unknown-state',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage connected accounts.');
    });

    it('throws if the OAuth state cannot be found or has expired', async () => {
      const result = await graphqlQueryV2(
        CONNECT_TRANSFERWISE_ACCOUNT_MUTATION,
        { code: 'oauth-code', profileId: String(businessProfile.id), state: 'expired-state' },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('could not be found or has expired');
    });

    it('throws if the user did not initiate the OAuth request', async () => {
      const state = 'state-wrong-user';
      await setOAuthState(state, {
        CollectiveId: host.id,
        redirect: 'https://opencollective.com/dashboard',
        UserId: user.id,
      });
      const result = await graphqlQueryV2(
        CONNECT_TRANSFERWISE_ACCOUNT_MUTATION,
        { code: 'oauth-code', profileId: String(businessProfile.id), state },
        otherUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You do not have permission to complete this Wise connection');
    });

    it('throws if the user is not an admin of the Collective', async () => {
      const state = 'state-not-admin';
      await setOAuthState(state, {
        CollectiveId: host.id,
        redirect: 'https://opencollective.com/dashboard',
        UserId: otherUser.id,
      });
      const result = await graphqlQueryV2(
        CONNECT_TRANSFERWISE_ACCOUNT_MUTATION,
        { code: 'oauth-code', profileId: String(businessProfile.id), state },
        otherUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You do not have permission to complete this Wise connection');
    });

    it('connects a Wise account and returns the redirect URL', async () => {
      const state = 'state-success';
      const redirect = 'https://opencollective.com/dashboard/host/host-settings';
      await setOAuthState(state, { CollectiveId: host.id, redirect, UserId: user.id });

      const result = await graphqlQueryV2(
        CONNECT_TRANSFERWISE_ACCOUNT_MUTATION,
        { code: 'oauth-code', profileId: String(businessProfile.id), state },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.connectTransferwiseAccount.connectedAccount.service).to.equal('transferwise');
      expect(result.data.connectTransferwiseAccount.redirectUrl).to.equal(redirect);

      // The token exchange must have been performed with the provided authorization code
      expect(getOrRefreshTokenStub.calledOnceWith({ code: 'oauth-code' })).to.be.true;

      // A connected account must have been persisted for the host with the Wise profile id
      const connectedAccount = await models.ConnectedAccount.findOne({
        where: { service: 'transferwise', CollectiveId: host.id },
      });
      expect(connectedAccount).to.exist;
      expect(connectedAccount.token).to.equal('new-access-token');
      expect(connectedAccount.refreshToken).to.equal('new-refresh-token');
      expect(connectedAccount.data.id).to.equal(businessProfile.id);

      // The OAuth state must be consumed so it cannot be replayed
      const cachedState = await sessionCache.get(`transferwise_oauth_${state}`);
      expect(cachedState).to.not.exist;
    });

    it('throws if the requested profile cannot be found on Wise', async () => {
      const state = 'state-missing-profile';
      await setOAuthState(state, {
        CollectiveId: host.id,
        redirect: 'https://opencollective.com/dashboard',
        UserId: user.id,
      });
      const result = await graphqlQueryV2(
        CONNECT_TRANSFERWISE_ACCOUNT_MUTATION,
        { code: 'oauth-code', profileId: '404404', state },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Could not find Wise profile with id 404404');
    });
  });
});
