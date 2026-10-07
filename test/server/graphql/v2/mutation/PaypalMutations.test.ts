/* eslint-disable camelcase */
import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import jwt from 'jsonwebtoken';
import nock from 'nock';
import { createSandbox, stub } from 'sinon';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import twoFactorAuthLib from '../../../../../server/lib/two-factor-authentication';
import models from '../../../../../server/models';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import { fakeCollective, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const GET_PAYPAL_OAUTH_URL_MUTATION = gql`
  mutation GetPaypalOAuthUrl($account: AccountReferenceInput!, $redirect: String, $currency: Currency) {
    getPaypalOAuthUrl(account: $account, redirect: $redirect, currency: $currency)
  }
`;

const CONNECT_PAYPAL_PAYOUT_METHOD_MUTATION = gql`
  mutation ConnectPaypalPayoutMethod(
    $code: NonEmptyString!
    $state: NonEmptyString!
    $account: AccountReferenceInput!
    $currency: Currency!
    $name: String
    $payoutMethod: PayoutMethodReferenceInput
  ) {
    connectPaypalPayoutMethod(
      code: $code
      state: $state
      account: $account
      currency: $currency
      name: $name
      payoutMethod: $payoutMethod
    ) {
      connectedAccount {
        id
        service
      }
      payoutMethod {
        id
        type
      }
    }
  }
`;

describe('server/graphql/v2/mutation/PaypalMutations', () => {
  const sandbox = createSandbox();
  const connectConfig = {
    clientId: 'test-paypal-connect-client-id',
    clientSecret: 'test-secret',
    redirectUri: 'https://example.com/services/paypal/oauth/callback',
  };

  let host, user, collective, configPaypalStub, enforceForAccountStub;

  const createPaypalConnectState = (collectiveId, userId) =>
    jwt.sign(
      { CollectiveId: collectiveId, userId, redirect: null, currency: 'USD' },
      config.keys.opencollective.jwtSecret,
      { expiresIn: '30m' },
    );

  before(async () => {
    await resetTestDB();
    host = await fakeUser();
    user = await fakeUser();
    collective = await fakeCollective({ admin: host });
  });

  beforeEach(() => {
    configPaypalStub = stub(config, 'paypal').get(() => ({
      connect: connectConfig,
      payment: { environment: 'sandbox' },
    }));
    enforceForAccountStub = sandbox.stub(twoFactorAuthLib, 'enforceForAccount').resolves();
  });

  afterEach(() => {
    configPaypalStub.restore();
    sandbox.restore();
    nock.cleanAll();
  });

  describe('getPaypalOAuthUrl', () => {
    it('throws if the user is not logged in', async () => {
      const result = await graphqlQueryV2(GET_PAYPAL_OAUTH_URL_MUTATION, {
        account: { legacyId: collective.id },
      });
      expect(result.errors).to.exist;
    });

    it('throws if PayPal Connect is not configured', async () => {
      configPaypalStub.restore();
      configPaypalStub = stub(config, 'paypal').get(() => ({
        connect: { ...connectConfig, clientId: null },
        payment: { environment: 'sandbox' },
      }));

      const result = await graphqlQueryV2(
        GET_PAYPAL_OAUTH_URL_MUTATION,
        { account: { legacyId: collective.id } },
        host,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('not available');
    });

    it('throws if the user is not an admin of the collective', async () => {
      const result = await graphqlQueryV2(
        GET_PAYPAL_OAUTH_URL_MUTATION,
        { account: { legacyId: collective.id } },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('admin');
    });

    it('returns an authorize URL for collective admins', async () => {
      const result = await graphqlQueryV2(
        GET_PAYPAL_OAUTH_URL_MUTATION,
        { account: { legacyId: collective.id }, redirect: 'https://example.com', currency: 'USD' },
        host,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.getPaypalOAuthUrl).to.include('client_id=test-paypal-connect-client-id');
      expect(result.data.getPaypalOAuthUrl).to.include('response_type=code');
      expect(enforceForAccountStub.called).to.be.true;
    });
  });

  describe('connectPaypalPayoutMethod', () => {
    const tokenResponse = {
      access_token: 'user-access-token',
      refresh_token: 'user-refresh-token',
      token_type: 'Bearer',
      expires_in: 28800,
    };
    const userInfo = {
      user_id: 'PAYER123',
      verified_account: 'true',
      emails: [{ value: 'john@example.com', primary: true, confirmed: true }],
    };

    const mockPaypalApi = () => {
      ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl => {
        nock(baseUrl).post('/v1/oauth2/token').reply(200, tokenResponse);
        nock(baseUrl).get('/v1/identity/oauth2/userinfo').query(true).reply(200, userInfo);
      });
    };

    it('throws if state is invalid', async () => {
      const result = await graphqlQueryV2(
        CONNECT_PAYPAL_PAYOUT_METHOD_MUTATION,
        {
          code: 'paypal-auth-code-123',
          state: 'invalid-state',
          account: { legacyId: collective.id },
          currency: 'USD',
        },
        host,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('invalid or expired');
    });

    it('throws if state user does not match', async () => {
      const result = await graphqlQueryV2(
        CONNECT_PAYPAL_PAYOUT_METHOD_MUTATION,
        {
          code: 'paypal-auth-code-123',
          state: createPaypalConnectState(collective.id, user.id),
          account: { legacyId: collective.id },
          currency: 'USD',
        },
        host,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('current user');
    });

    it('creates ConnectedAccount and PayoutMethod on success', async () => {
      mockPaypalApi();
      const result = await graphqlQueryV2(
        CONNECT_PAYPAL_PAYOUT_METHOD_MUTATION,
        {
          code: 'paypal-auth-code-123',
          state: createPaypalConnectState(collective.id, host.id),
          account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
          currency: 'USD',
          name: 'My PayPal',
        },
        host,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.connectPaypalPayoutMethod.connectedAccount.service).to.equal('paypal');
      expect(result.data.connectPaypalPayoutMethod.payoutMethod.type).to.equal('PAYPAL');

      const connectedAccount = await models.ConnectedAccount.findOne({
        where: { CollectiveId: collective.id, service: 'paypal' },
      });
      expect(connectedAccount).to.exist;
      expect(connectedAccount.username).to.equal('john@example.com');

      const payoutMethod = await models.PayoutMethod.findOne({
        where: { CollectiveId: collective.id, type: PayoutMethodTypes.PAYPAL },
      });
      expect(payoutMethod).to.exist;
      expect((payoutMethod.data as { email?: string })?.email).to.equal('john@example.com');
    });

    it('returns error when PayPal account is not verified', async () => {
      const unverifiedInfo = {
        user_id: 'PAYER123',
        verified_account: 'false',
        emails: [{ value: 'verified@example.com', primary: true, confirmed: true }],
      };
      ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl => {
        nock(baseUrl).post('/v1/oauth2/token').reply(200, tokenResponse);
        nock(baseUrl).get('/v1/identity/oauth2/userinfo').query(true).reply(200, unverifiedInfo);
      });

      const result = await graphqlQueryV2(
        CONNECT_PAYPAL_PAYOUT_METHOD_MUTATION,
        {
          code: 'paypal-auth-code-123',
          state: createPaypalConnectState(collective.id, host.id),
          account: { legacyId: collective.id },
          currency: 'USD',
        },
        host,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('not verified');
    });
  });
});
