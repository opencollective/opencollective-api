import { expect } from 'chai';
import gql from 'fake-tag';
import moment from 'moment';
import { createSandbox } from 'sinon';

import { sessionCache } from '../../../../../server/lib/cache';
import * as transferwiseLib from '../../../../../server/lib/transferwise';
import models from '../../../../../server/models';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const CONNECT_TRANSFERWISE_ACCOUNT_MUTATION = gql`
  mutation ConnectTransferwiseAccount($code: String!, $profileId: String!, $state: String!) {
    connectTransferwiseAccount(code: $code, profileId: $profileId, state: $state) {
      connectedAccount {
        id
        service
      }
      redirectUrl
    }
  }
`;

describe('server/graphql/v2/mutation/TransferwiseMutations', () => {
  const sandbox = createSandbox();

  // The profile that we'll connect. `userId` is the Wise personal profile owner id.
  const personalProfile = { id: 217896, type: 'PERSONAL', userId: 9999 };
  const businessProfile = { id: 220192, type: 'BUSINESS', companyRole: 'OWNER', userId: 9999 };

  let user, host, otherUser;
  let getOrRefreshTokenStub;

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
  });

  afterEach(() => sandbox.restore());

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
