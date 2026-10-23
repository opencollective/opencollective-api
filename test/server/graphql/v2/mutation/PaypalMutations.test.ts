/* eslint-disable camelcase */
import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import jwt from 'jsonwebtoken';
import nock from 'nock';
import { createSandbox, SinonStub } from 'sinon';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import RateLimit from '../../../../../server/lib/rate-limit';
import * as SentryLib from '../../../../../server/lib/sentry';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import models, { Collective, User } from '../../../../../server/models';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import { fakeCollective, fakePayoutMethod, fakeUser, fakeUserToken, randStr } from '../../../../test-helpers/fake-data';
import { generateValid2FAHeader, graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

const GET_PAYPAL_OAUTH_URL_MUTATION = gql`
  mutation GetPaypalOAuthUrl($account: AccountReferenceInput!, $currency: Currency) {
    getPaypalOAuthUrl(account: $account, currency: $currency)
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

const PAYPAL_API_URL = 'https://api.sandbox.paypal.com';

const tokenResponse = {
  access_token: 'user-access-token',
  refresh_token: 'user-refresh-token',
  token_type: 'Bearer',
  expires_in: 28800,
};

const verifiedUserInfo = {
  user_id: 'PAYER123',
  name: 'John Doe',
  verified_account: 'true',
  emails: [
    { value: 'secondary@example.com', primary: false, confirmed: true },
    { value: 'john@example.com', primary: true, confirmed: true },
  ],
};

const mockPaypalApi = (userInfo = verifiedUserInfo, { times = 1 } = {}) => {
  nock(PAYPAL_API_URL).post('/v1/oauth2/token').times(times).reply(200, tokenResponse);
  nock(PAYPAL_API_URL).get('/v1/identity/oauth2/userinfo').query(true).times(times).reply(200, userInfo);
};

const createPaypalConnectState = (collectiveId: number, userId: number, { expiresIn = '30m' } = {}) =>
  jwt.sign({ CollectiveId: collectiveId, userId, currency: 'USD' }, config.keys.opencollective.jwtSecret, {
    expiresIn,
  } as jwt.SignOptions);

const newSession = () => ({ sessionId: randStr('session-') });

/** Asserts that the result has a single user-facing error, with a code (so it's not reported to Sentry) */
const expectError = (result, code: string, message?: string) => {
  expect(result.errors, 'Expected an error').to.exist;
  expect(result.errors).to.have.length(1);
  expect(result.errors[0].extensions.code).to.equal(code);
  if (message) {
    expect(result.errors[0].message).to.include(message);
  }
};

describe('server/graphql/v2/mutation/PaypalMutations', () => {
  const sandbox = createSandbox();
  const connectConfig = {
    clientId: 'test-paypal-connect-client-id',
    clientSecret: 'test-secret',
    redirectUri: 'https://example.com/services/paypal/oauth/callback',
  };

  let admin: User, randomUser: User, collective: Collective, reportErrorToSentryStub: SinonStub;

  const stubPaypalConfig = (connect: Record<string, unknown> = connectConfig) => {
    sandbox.stub(config, 'paypal').get(() => ({ connect, payment: { environment: 'sandbox' } }));
  };

  before(async () => {
    await resetTestDB();
  });

  beforeEach(async () => {
    admin = await fakeUser();
    randomUser = await fakeUser();
    collective = await fakeCollective({ admin });
    await new RateLimit(`paypal-connect-${admin.id}`, 10, 30 * 60).reset(); // User IDs can be reused across test files
    stubPaypalConfig();
    reportErrorToSentryStub = sandbox.stub(SentryLib, 'reportErrorToSentry');
  });

  afterEach(() => {
    sandbox.restore();
    nock.cleanAll();
  });

  describe('getPaypalOAuthUrl', () => {
    const getOAuthUrl = (remoteUser: User, variables = {}, { headers = {}, jwtPayload = newSession() } = {}) =>
      graphqlQueryV2(
        GET_PAYPAL_OAUTH_URL_MUTATION,
        { account: { legacyId: collective.id }, ...variables },
        remoteUser,
        jwtPayload,
        headers,
      );

    afterEach(() => {
      expect(reportErrorToSentryStub.called, 'No error should be reported to Sentry').to.be.false;
    });

    it('throws if the user is not logged in', async () => {
      const result = await getOAuthUrl(null);
      expectError(result, 'Unauthorized');
    });

    it('throws if PayPal Connect is not configured', async () => {
      sandbox.restore();
      stubPaypalConfig({ ...connectConfig, clientId: null });
      reportErrorToSentryStub = sandbox.stub(SentryLib, 'reportErrorToSentry');

      const result = await getOAuthUrl(admin);
      expectError(result, 'NotFound', 'PayPal Connect is not available at the moment.');
    });

    it('throws if the account does not exist', async () => {
      const result = await getOAuthUrl(admin, { account: { legacyId: 999999 } });
      expectError(result, 'NotFound', 'Account Not Found');
    });

    it('throws if the user is not an admin of the account', async () => {
      const result = await getOAuthUrl(randomUser);
      expectError(result, 'Forbidden', 'You must be an admin of this collective');
    });

    it('requires the "expenses" scope for OAuth tokens', async () => {
      const variables = { account: { legacyId: collective.id } };
      const tokenWithoutScope = await fakeUserToken({ user: admin, scope: ['account'] });
      const resultWithoutScope = await oAuthGraphqlQueryV2(GET_PAYPAL_OAUTH_URL_MUTATION, variables, tokenWithoutScope);
      expectError(resultWithoutScope, 'Forbidden', 'The User Token is not allowed for operations in scope "expenses".');

      const tokenWithScope = await fakeUserToken({ user: admin, scope: ['expenses'] });
      const resultWithScope = await oAuthGraphqlQueryV2(GET_PAYPAL_OAUTH_URL_MUTATION, variables, tokenWithScope);
      resultWithScope.errors && console.error(resultWithScope.errors);
      expect(resultWithScope.errors).to.not.exist;
      expect(resultWithScope.data.getPaypalOAuthUrl).to.be.a('string');
    });

    it('requires 2FA when the admin has it enabled', async () => {
      const adminWith2FA = await fakeUser({}, {}, { enable2FA: true });
      await collective.addUserWithRole(adminWith2FA, 'ADMIN');

      const withoutToken = await getOAuthUrl(adminWith2FA);
      expectError(withoutToken, '2FA_REQUIRED');

      const withToken = await getOAuthUrl(
        adminWith2FA,
        {},
        {
          headers: { [TwoFactorAuthenticationHeader]: generateValid2FAHeader(adminWith2FA) },
        },
      );
      withToken.errors && console.error(withToken.errors);
      expect(withToken.errors).to.not.exist;
      expect(withToken.data.getPaypalOAuthUrl).to.be.a('string');
    });

    it('requires 2FA when the account enforces it for admins', async () => {
      await collective.update({ data: { ...collective.data, policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
      const result = await getOAuthUrl(admin);
      expectError(result, '2FA_REQUIRED', 'Two factor authentication must be configured');
    });

    it('returns the PayPal authorize URL with a signed state', async () => {
      const result = await getOAuthUrl(admin, { currency: 'EUR' });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const url = new URL(result.data.getPaypalOAuthUrl);
      expect(`${url.origin}${url.pathname}`).to.equal('https://www.sandbox.paypal.com/connect/');
      expect(url.searchParams.get('client_id')).to.equal(connectConfig.clientId);
      expect(url.searchParams.get('redirect_uri')).to.equal(connectConfig.redirectUri);
      expect(url.searchParams.get('response_type')).to.equal('code');
      expect(url.searchParams.get('flowEntry')).to.equal('static');
      expect(url.searchParams.get('scope')).to.equal(
        'openid profile email https://uri.paypal.com/services/paypalattributes',
      );

      const state = jwt.verify(url.searchParams.get('state'), config.keys.opencollective.jwtSecret);
      expect(state).to.include({ CollectiveId: collective.id, userId: admin.id, currency: 'EUR' });
    });

    it('throws if the currency is not supported by PayPal', async () => {
      const result = await getOAuthUrl(admin, { currency: 'XAF' });
      expectError(result, 'ValidationFailed', 'This currency is not supported by PayPal');
    });

    it('defaults the currency in the state to USD', async () => {
      const result = await getOAuthUrl(admin);
      expect(result.errors).to.not.exist;
      const url = new URL(result.data.getPaypalOAuthUrl);
      const state = jwt.verify(url.searchParams.get('state'), config.keys.opencollective.jwtSecret);
      expect(state).to.include({ currency: 'USD' });
    });
  });

  describe('connectPaypalPayoutMethod', () => {
    const connectPaypal = (remoteUser: User, variables = {}, { headers = {}, jwtPayload = newSession() } = {}) =>
      graphqlQueryV2(
        CONNECT_PAYPAL_PAYOUT_METHOD_MUTATION,
        {
          code: 'paypal-auth-code-123',
          state: createPaypalConnectState(collective.id, remoteUser?.id ?? admin.id),
          account: { legacyId: collective.id },
          currency: 'USD',
          ...variables,
        },
        remoteUser,
        jwtPayload,
        headers,
      );

    const countPaypalRecords = async () => ({
      connectedAccounts: await models.ConnectedAccount.count({ where: { CollectiveId: collective.id } }),
      payoutMethods: await models.PayoutMethod.count({
        where: { CollectiveId: collective.id, type: PayoutMethodTypes.PAYPAL },
      }),
    });

    describe('user-facing errors', () => {
      afterEach(async () => {
        expect(reportErrorToSentryStub.called, 'No error should be reported to Sentry').to.be.false;
        expect(await models.ConnectedAccount.count({ where: { CollectiveId: collective.id } })).to.equal(0);
      });

      it('throws if the user is not logged in', async () => {
        const result = await connectPaypal(null);
        expectError(result, 'Unauthorized');
      });

      it('throws if PayPal Connect is not configured', async () => {
        sandbox.restore();
        stubPaypalConfig({ ...connectConfig, clientId: null });
        reportErrorToSentryStub = sandbox.stub(SentryLib, 'reportErrorToSentry');

        const result = await connectPaypal(admin);
        expectError(result, 'NotFound', 'PayPal Connect is not available at the moment.');
      });

      it('throws if the state is invalid', async () => {
        const result = await connectPaypal(admin, { state: 'invalid-state' });
        expectError(result, 'BadRequest', 'invalid or expired');
      });

      it('throws if the state is expired', async () => {
        const state = createPaypalConnectState(collective.id, admin.id, { expiresIn: '-1s' });
        const result = await connectPaypal(admin, { state });
        expectError(result, 'BadRequest', 'invalid or expired');
      });

      it('throws if the state was issued for another user', async () => {
        const otherAdmin = await fakeUser();
        await collective.addUserWithRole(otherAdmin, 'ADMIN');
        const result = await connectPaypal(admin, { state: createPaypalConnectState(collective.id, otherAdmin.id) });
        expectError(result, 'Forbidden', 'does not match the current user');
      });

      it('throws if the state was issued for another account', async () => {
        const otherCollective = await fakeCollective({ admin });
        const result = await connectPaypal(admin, { state: createPaypalConnectState(otherCollective.id, admin.id) });
        expectError(result, 'Forbidden', 'does not match the requested account');
      });

      it('throws if the user is not an admin of the account', async () => {
        const result = await connectPaypal(randomUser);
        expectError(result, 'Forbidden', 'You must be an admin of this collective');
      });

      it('throws if the account does not exist', async () => {
        const result = await connectPaypal(admin, { account: { legacyId: 999999 } });
        expectError(result, 'NotFound', 'Account Not Found');
      });

      it('throws if the payout method does not exist', async () => {
        const payoutMethod = { id: idEncode(999999, IDENTIFIER_TYPES.PAYOUT_METHOD) };
        const result = await connectPaypal(admin, { payoutMethod });
        expectError(result, 'NotFound', 'Payout Method Not Found');
      });

      it('throws if the payout method belongs to another account', async () => {
        const otherCollective = await fakeCollective({ admin });
        const otherPayoutMethod = await fakePayoutMethod({
          type: PayoutMethodTypes.PAYPAL,
          CollectiveId: otherCollective.id,
          currency: 'USD',
          data: { email: 'john@example.com' },
        });
        const payoutMethod = { id: idEncode(otherPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) };
        const result = await connectPaypal(admin, { payoutMethod });
        expectError(result, 'Forbidden', 'The payout method is not associated with this account');
      });

      it('throws if the payout method is not a PayPal payout method', async () => {
        const bankPayoutMethod = await fakePayoutMethod({
          type: PayoutMethodTypes.BANK_ACCOUNT,
          CollectiveId: collective.id,
          currency: 'EUR',
        });
        const payoutMethod = { id: idEncode(bankPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) };
        const result = await connectPaypal(admin, { payoutMethod });
        expectError(result, 'Forbidden', 'The payout method is not a PayPal payout method');
      });

      it('throws if the currency is not supported by PayPal, without exchanging the code', async () => {
        const tokenExchange = nock(PAYPAL_API_URL).post('/v1/oauth2/token').reply(200, tokenResponse);
        const result = await connectPaypal(admin, { currency: 'XAF' });
        expectError(result, 'ValidationFailed', 'This currency is not supported by PayPal');
        expect(tokenExchange.isDone(), 'The PayPal code should not be spent').to.be.false;
      });

      it('throws if the PayPal account has no confirmed email', async () => {
        mockPaypalApi({
          ...verifiedUserInfo,
          emails: [{ value: 'unconfirmed@example.com', primary: true, confirmed: false }],
        });
        const result = await connectPaypal(admin);
        expectError(result, 'BadRequest', 'not associated with a confirmed email address');
      });

      it('throws if the PayPal account is not verified', async () => {
        mockPaypalApi({ ...verifiedUserInfo, verified_account: 'false' });
        const result = await connectPaypal(admin);
        expectError(result, 'BadRequest', 'This PayPal account is not verified');
      });

      it('is rate limited to 10 attempts per user', async () => {
        mockPaypalApi({ ...verifiedUserInfo, verified_account: 'false' }, { times: 10 });
        for (let i = 0; i < 10; i++) {
          const result = await connectPaypal(admin);
          expectError(result, 'BadRequest', 'not verified');
        }

        const result = await connectPaypal(admin);
        expectError(result, 'RateLimitExceeded', 'Rate limit exceeded');
      });

      it('requires the "expenses" scope for OAuth tokens', async () => {
        const userToken = await fakeUserToken({ user: admin, scope: ['account'] });
        const result = await oAuthGraphqlQueryV2(
          CONNECT_PAYPAL_PAYOUT_METHOD_MUTATION,
          {
            code: 'paypal-auth-code-123',
            state: createPaypalConnectState(collective.id, admin.id),
            account: { legacyId: collective.id },
            currency: 'USD',
          },
          userToken,
        );
        expectError(result, 'Forbidden', 'The User Token is not allowed for operations in scope "expenses".');
      });

      it('requires 2FA when the account enforces it for admins', async () => {
        await collective.update({ data: { ...collective.data, policies: { REQUIRE_2FA_FOR_ADMINS: true } } });
        const result = await connectPaypal(admin);
        expectError(result, '2FA_REQUIRED', 'Two factor authentication must be configured');
      });
    });

    it('reports unexpected PayPal errors to Sentry and returns a generic error', async () => {
      nock(PAYPAL_API_URL).post('/v1/oauth2/token').reply(400, { error: 'invalid_grant' });

      const result = await connectPaypal(admin);
      expectError(result, 'UnexpectedError', 'PayPal connect failed');
      expect(reportErrorToSentryStub.calledOnce).to.be.true;

      const [reportedError, params] = reportErrorToSentryStub.firstCall.args;
      expect(reportedError.message).to.not.equal('PayPal connect failed');
      expect(reportedError).to.not.have.nested.property('extensions.code');
      expect(params.user).to.equal(admin);
      expect(params.req).to.exist;
      expect(params.extra).to.deep.include({ CollectiveId: collective.id });
      expect(JSON.stringify(params)).to.not.include('paypal-auth-code-123');
      expect(await countPaypalRecords()).to.deep.equal({ connectedAccounts: 0, payoutMethods: 0 });
    });

    it('requires 2FA when the admin has it enabled', async () => {
      const adminWith2FA = await fakeUser({}, {}, { enable2FA: true });
      await collective.addUserWithRole(adminWith2FA, 'ADMIN');
      const jwtPayload = newSession();

      const withoutToken = await connectPaypal(adminWith2FA, {}, { jwtPayload });
      expectError(withoutToken, '2FA_REQUIRED');
      expect(await countPaypalRecords()).to.deep.equal({ connectedAccounts: 0, payoutMethods: 0 });

      mockPaypalApi();
      const withToken = await connectPaypal(
        adminWith2FA,
        {},
        {
          jwtPayload,
          headers: { [TwoFactorAuthenticationHeader]: generateValid2FAHeader(adminWith2FA) },
        },
      );
      withToken.errors && console.error(withToken.errors);
      expect(withToken.errors).to.not.exist;
      expect(await countPaypalRecords()).to.deep.equal({ connectedAccounts: 1, payoutMethods: 1 });
    });

    it('accepts OAuth tokens with the "expenses" scope', async () => {
      mockPaypalApi();
      const userToken = await fakeUserToken({ user: admin, scope: ['expenses'] });
      const result = await oAuthGraphqlQueryV2(
        CONNECT_PAYPAL_PAYOUT_METHOD_MUTATION,
        {
          code: 'paypal-auth-code-123',
          state: createPaypalConnectState(collective.id, admin.id),
          account: { legacyId: collective.id },
          currency: 'USD',
        },
        userToken,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(await countPaypalRecords()).to.deep.equal({ connectedAccounts: 1, payoutMethods: 1 });
    });

    it('creates a ConnectedAccount and a PayoutMethod', async () => {
      mockPaypalApi();
      const result = await connectPaypal(admin, {
        account: { id: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT) },
        currency: 'EUR',
        name: 'My PayPal',
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const connectedAccount = await models.ConnectedAccount.findOne({ where: { CollectiveId: collective.id } });
      expect(connectedAccount).to.exist;
      expect(connectedAccount.service).to.equal('paypal');
      expect(connectedAccount.username).to.equal('john@example.com');
      expect(connectedAccount.token).to.equal('user-access-token');
      expect(connectedAccount.refreshToken).to.equal('user-refresh-token');
      expect(connectedAccount.CreatedByUserId).to.equal(admin.id);
      expect(connectedAccount.clientId).to.not.exist; // Would make the connected account usable for payouts
      expect(connectedAccount.data).to.deep.equal({ payerId: 'PAYER123' });

      const payoutMethod = await models.PayoutMethod.findOne({
        where: { CollectiveId: collective.id, type: PayoutMethodTypes.PAYPAL },
      });
      expect(payoutMethod).to.exist;
      expect(payoutMethod.name).to.equal('My PayPal');
      expect(payoutMethod.isSaved).to.be.true;
      expect(payoutMethod.currency).to.equal('EUR');
      expect(payoutMethod.CreatedByUserId).to.equal(admin.id);
      expect(payoutMethod.ConnectedAccountId).to.equal(connectedAccount.id);
      expect(payoutMethod.data).to.deep.include({ isPayPalOAuth: true, currency: 'EUR', email: 'john@example.com' });
      expect(payoutMethod.data).to.have.property('verifiedAt');
      expect(payoutMethod.data).to.have.nested.property('paypalUserInfo.name', 'John Doe');
      expect(payoutMethod.data).not.to.have.property('connectedAccountId');

      expect(result.data.connectPaypalPayoutMethod).to.deep.equal({
        connectedAccount: {
          id: idEncode(connectedAccount.id, IDENTIFIER_TYPES.CONNECTED_ACCOUNT),
          service: 'paypal',
        },
        payoutMethod: { id: idEncode(payoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD), type: 'PAYPAL' },
      });
    });

    it('defaults the payout method name to the PayPal email', async () => {
      mockPaypalApi();
      const result = await connectPaypal(admin);
      expect(result.errors).to.not.exist;
      const payoutMethod = await models.PayoutMethod.findOne({ where: { CollectiveId: collective.id } });
      expect(payoutMethod.name).to.equal('john@example.com');
    });

    it('verifies an existing payout method in place', async () => {
      const existingPayoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        CollectiveId: collective.id,
        name: 'Legacy PayPal',
        currency: 'EUR',
        data: { email: 'secondary@example.com', currency: 'EUR' },
      });

      mockPaypalApi();
      const result = await connectPaypal(admin, {
        payoutMethod: { id: idEncode(existingPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
        currency: 'USD',
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.connectPaypalPayoutMethod.payoutMethod.id).to.equal(
        idEncode(existingPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD),
      );
      expect(await countPaypalRecords()).to.deep.equal({ connectedAccounts: 1, payoutMethods: 1 });

      const connectedAccount = await models.ConnectedAccount.findOne({ where: { CollectiveId: collective.id } });
      await existingPayoutMethod.reload();
      expect(existingPayoutMethod.name).to.equal('Legacy PayPal');
      expect(existingPayoutMethod.currency).to.equal('USD');
      expect(existingPayoutMethod.ConnectedAccountId).to.equal(connectedAccount.id);
      expect(existingPayoutMethod.data).to.deep.include({
        isPayPalOAuth: true,
        currency: 'USD',
        email: 'john@example.com', // Primary email
      });
    });

    it('creates a new payout method if the PayPal account email does not match the existing one', async () => {
      const existingPayoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        CollectiveId: collective.id,
        currency: 'EUR',
        data: { email: 'someone-else@example.com', currency: 'EUR' },
      });

      mockPaypalApi();
      const result = await connectPaypal(admin, {
        payoutMethod: { id: idEncode(existingPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(await countPaypalRecords()).to.deep.equal({ connectedAccounts: 1, payoutMethods: 2 });

      const newPayoutMethodId = result.data.connectPaypalPayoutMethod.payoutMethod.id;
      expect(newPayoutMethodId).to.not.equal(idEncode(existingPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD));

      await existingPayoutMethod.reload();
      expect(existingPayoutMethod.ConnectedAccountId).to.be.null;
      expect(existingPayoutMethod.currency).to.equal('EUR');
      expect(existingPayoutMethod.data).to.deep.equal({ email: 'someone-else@example.com', currency: 'EUR' });
    });
  });
});
