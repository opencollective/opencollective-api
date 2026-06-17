/* eslint-disable camelcase */
import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox } from 'sinon';

import { sessionCache } from '../../../../../server/lib/cache';
import stripeLib from '../../../../../server/lib/stripe';
import twoFactorAuthLib from '../../../../../server/lib/two-factor-authentication';
import models from '../../../../../server/models';
import { fakeActiveHost, fakeConnectedAccount, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const CONNECT_STRIPE_ACCOUNT_MUTATION = gql`
  mutation ConnectStripeAccount($code: NonEmptyString!, $state: NonEmptyString!) {
    connectStripeAccount(code: $code, state: $state) {
      connectedAccount {
        id
        service
      }
      redirectUrl
    }
  }
`;

const GET_STRIPE_OAUTH_URL_MUTATION = gql`
  mutation GetStripeOAuthUrl($account: AccountReferenceInput!, $redirect: String) {
    getStripeOAuthUrl(account: $account, redirect: $redirect)
  }
`;

describe('server/graphql/v2/mutation/StripeMutations', () => {
  const sandbox = createSandbox();

  // Mocked Stripe responses for the OAuth token exchange and account retrieval
  const stripeOAuthTokenResponse = {
    access_token: 'sk_test_new',
    refresh_token: 'rt_new',
    token_type: 'bearer',
    stripe_publishable_key: 'pk_test_new',
    stripe_user_id: 'acct_new_123',
    scope: 'read_write',
  };
  const stripeAccountResponse = {
    id: 'acct_new_123',
    object: 'account',
    country: 'BE',
    default_currency: 'eur',
    timezone: 'Europe/Madrid',
    legal_entity: {
      address: {
        line1: '1 Test Street',
        line2: null,
        country: 'BE',
        state: null,
        city: 'Brussels',
        postal_code: '1000',
      },
    },
  };

  let user, host, otherUser;
  let stripeOAuthTokenStub;
  let stripeAccountsRetrieveStub;
  let enforceForAccountStub;

  before(async () => {
    await resetTestDB();
    user = await fakeUser();
    otherUser = await fakeUser();
    host = await fakeActiveHost({ admin: user, currency: 'USD' });
    await host.addUserWithRole(user, 'ADMIN');
  });

  beforeEach(() => {
    stripeOAuthTokenStub = sandbox.stub(stripeLib.oauth, 'token').resolves(stripeOAuthTokenResponse as any);
    stripeAccountsRetrieveStub = sandbox.stub(stripeLib.accounts, 'retrieve').resolves(stripeAccountResponse as any);
    enforceForAccountStub = sandbox.stub(twoFactorAuthLib, 'enforceForAccount').resolves();
  });

  afterEach(() => sandbox.restore());

  describe('getStripeOAuthUrl', () => {
    const VALID_REDIRECT = 'http://localhost:3000/dashboard/host-settings';

    it('throws if the user is not logged in', async () => {
      const result = await graphqlQueryV2(GET_STRIPE_OAUTH_URL_MUTATION, { account: { slug: host.slug } });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage connected accounts.');
    });

    it('throws if the account does not exist', async () => {
      const result = await graphqlQueryV2(
        GET_STRIPE_OAUTH_URL_MUTATION,
        { account: { slug: 'non-existent-collective' } },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Account Not Found');
    });

    it('throws if the user is not an admin of the account', async () => {
      const result = await graphqlQueryV2(GET_STRIPE_OAUTH_URL_MUTATION, { account: { slug: host.slug } }, otherUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('must be an admin');
    });

    it('throws if the redirect URL has an invalid origin', async () => {
      const result = await graphqlQueryV2(
        GET_STRIPE_OAUTH_URL_MUTATION,
        { account: { slug: host.slug }, redirect: 'https://evil.com/steal-token' },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Invalid redirect url');
    });

    it('returns the Stripe OAuth URL without a redirect and caches the state', async () => {
      const result = await graphqlQueryV2(GET_STRIPE_OAUTH_URL_MUTATION, { account: { slug: host.slug } }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const url = new URL(result.data.getStripeOAuthUrl);
      expect(`${url.origin}${url.pathname}`).to.equal('https://connect.stripe.com/oauth/authorize');
      expect(url.searchParams.get('response_type')).to.equal('code');
      expect(url.searchParams.get('scope')).to.equal('read_write');

      // A session cache entry must have been created for the generated state
      const state = url.searchParams.get('state');
      expect(state).to.be.a('string').and.not.empty;
      const cached = await sessionCache.get(`stripe_oauth_${state}`);
      expect(cached).to.exist;
      expect(cached.CollectiveId).to.equal(host.id);
      expect(cached.UserId).to.equal(user.id);
      expect(cached.redirect).to.be.undefined;
    });

    it('returns the Stripe OAuth URL with a valid redirect and stores it in the session cache', async () => {
      const result = await graphqlQueryV2(
        GET_STRIPE_OAUTH_URL_MUTATION,
        { account: { slug: host.slug }, redirect: VALID_REDIRECT },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const state = new URL(result.data.getStripeOAuthUrl).searchParams.get('state');
      const cached = await sessionCache.get(`stripe_oauth_${state}`);
      expect(cached).to.exist;
      expect(cached.redirect).to.equal(VALID_REDIRECT);
      expect(cached.CollectiveId).to.equal(host.id);
      expect(cached.UserId).to.equal(user.id);
    });

    it('enforces two-factor authentication for the account', async () => {
      const result = await graphqlQueryV2(GET_STRIPE_OAUTH_URL_MUTATION, { account: { slug: host.slug } }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(enforceForAccountStub.calledOnce).to.be.true;
      const [, accountArg] = enforceForAccountStub.firstCall.args;
      expect(accountArg.id).to.equal(host.id);
    });
  });

  describe('connectStripeAccount', () => {
    const setOAuthState = async (state: string, payload: Record<string, unknown>) => {
      await sessionCache.set(`stripe_oauth_${state}`, payload, 60 * 45);
    };

    beforeEach(async () => {
      // Clean up any previously-connected Stripe account between tests
      await models.ConnectedAccount.destroy({ where: { service: 'stripe' } });
    });

    it('throws if the user is not logged in', async () => {
      const result = await graphqlQueryV2(CONNECT_STRIPE_ACCOUNT_MUTATION, {
        code: 'oauth-code',
        state: 'unknown-state',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage connected accounts.');
    });

    it('throws if the OAuth state cannot be found or has expired', async () => {
      const result = await graphqlQueryV2(
        CONNECT_STRIPE_ACCOUNT_MUTATION,
        { code: 'oauth-code', state: 'expired-state' },
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
      const result = await graphqlQueryV2(CONNECT_STRIPE_ACCOUNT_MUTATION, { code: 'oauth-code', state }, otherUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You do not have permission to complete this Stripe connection');
    });

    it('throws if the user is not an admin of the Collective', async () => {
      const state = 'state-not-admin';
      await setOAuthState(state, {
        CollectiveId: host.id,
        redirect: 'https://opencollective.com/dashboard',
        UserId: otherUser.id,
      });
      const result = await graphqlQueryV2(CONNECT_STRIPE_ACCOUNT_MUTATION, { code: 'oauth-code', state }, otherUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You do not have permission to complete this Stripe connection');
    });

    it('connects a Stripe account and returns the redirect URL', async () => {
      const state = 'state-success';
      const redirect = 'https://opencollective.com/dashboard/host/host-settings';
      await setOAuthState(state, { CollectiveId: host.id, redirect, UserId: user.id });

      const result = await graphqlQueryV2(CONNECT_STRIPE_ACCOUNT_MUTATION, { code: 'oauth-code', state }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.connectStripeAccount.connectedAccount.service).to.equal('stripe');
      expect(result.data.connectStripeAccount.redirectUrl).to.equal(redirect);

      // The token exchange must have been performed with the provided authorization code
      expect(stripeOAuthTokenStub.calledOnce).to.be.true;
      expect(stripeOAuthTokenStub.firstCall.args[0]).to.deep.equal({
        grant_type: 'authorization_code',
        code: 'oauth-code',
      });
      expect(stripeAccountsRetrieveStub.calledOnceWith('acct_new_123')).to.be.true;

      // A connected account must have been persisted for the host
      const connectedAccount = await models.ConnectedAccount.findOne({
        where: { service: 'stripe', CollectiveId: host.id },
      });
      expect(connectedAccount).to.exist;
      expect(connectedAccount.username).to.equal('acct_new_123');
      expect(connectedAccount.token).to.equal('sk_test_new');
      expect(connectedAccount.refreshToken).to.equal('rt_new');
      expect(connectedAccount.data.publishableKey).to.equal('pk_test_new');
      expect(connectedAccount.data.scope).to.equal('read_write');
      expect(connectedAccount.data.account.default_currency).to.equal('eur');

      // The OAuth state must be consumed so it cannot be replayed
      const cachedState = await sessionCache.get(`stripe_oauth_${state}`);
      expect(cachedState).to.not.exist;

      // Currency and timezone should be synchronized from Stripe data
      await host.reload();
      expect(host.currency).to.equal('EUR');
      expect(host.timezone).to.equal('Europe/Madrid');
    });

    it('replaces an existing Stripe connected account when reconnecting', async () => {
      // Seed a pre-existing Stripe connected account for the host
      const previousConnectedAccount = await fakeConnectedAccount({
        service: 'stripe',
        CollectiveId: host.id,
        username: 'acct_old_999',
        token: 'sk_test_old',
        refreshToken: 'rt_old',
      });

      const state = 'state-reconnect';
      const redirect = 'https://opencollective.com/dashboard/host/host-settings';
      await setOAuthState(state, { CollectiveId: host.id, redirect, UserId: user.id });

      const result = await graphqlQueryV2(CONNECT_STRIPE_ACCOUNT_MUTATION, { code: 'oauth-code', state }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.connectStripeAccount.connectedAccount.service).to.equal('stripe');

      // The previous connected account must have been removed
      const previous = await models.ConnectedAccount.findByPk(previousConnectedAccount.id);
      expect(previous).to.not.exist;

      // Only the new connected account should exist for this host
      const remaining = await models.ConnectedAccount.findAll({
        where: { service: 'stripe', CollectiveId: host.id },
      });
      expect(remaining).to.have.length(1);
      expect(remaining[0].id).to.not.equal(previousConnectedAccount.id);
      expect(remaining[0].username).to.equal('acct_new_123');
      expect(remaining[0].token).to.equal('sk_test_new');
      expect(remaining[0].refreshToken).to.equal('rt_new');
    });

    it('enforces two-factor authentication for the account when completing the connection', async () => {
      const state = 'state-2fa';
      await setOAuthState(state, { CollectiveId: host.id, UserId: user.id });

      const result = await graphqlQueryV2(CONNECT_STRIPE_ACCOUNT_MUTATION, { code: 'oauth-code', state }, user);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(enforceForAccountStub.calledOnce).to.be.true;
      const [, accountArg] = enforceForAccountStub.firstCall.args;
      expect(accountArg.id).to.equal(host.id);
    });
  });
});
