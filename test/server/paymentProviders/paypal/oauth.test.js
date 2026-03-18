/* eslint-disable camelcase */
import { expect } from 'chai';
import config from 'config';
import express from 'express';
import jwt from 'jsonwebtoken';
import { omit } from 'lodash';
import nock from 'nock';
import { stub } from 'sinon';
import request from 'supertest';

import { idEncode, IDENTIFIER_TYPES } from '../../../../server/graphql/v2/identifiers';
import setupExpress from '../../../../server/lib/express';
import models from '../../../../server/models';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import routes from '../../../../server/routes';
import { fakeCollective, fakeUser } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const application = utils.data('application');

describe('server/paymentProviders/paypal/oauth', () => {
  let host, user, collective, expressApp, configPaypalStub;

  const connectConfig = {
    clientId: 'test-paypal-connect-client-id',
    clientSecret: 'test-secret',
    redirectUri: 'https://example.com/services/paypal/oauth/callback',
  };

  before(async () => {
    expressApp = express();
    setupExpress(expressApp);
    await routes(expressApp);
  });

  beforeEach(async () => {
    await utils.resetTestDB();
    host = await fakeUser();
    user = await fakeUser();
    collective = await fakeCollective({ admin: host });
  });

  describe('GET /connected-accounts/paypal/connect-config', () => {
    it('returns 404 when PayPal Connect clientId is not configured', async () => {
      configPaypalStub = stub(config, 'paypal').get(() => ({
        connect: { ...connectConfig, clientId: null },
      }));

      const accountId = idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT);
      const res = await request(expressApp)
        .get(
          `/connected-accounts/paypal/connect-config?accountId=${accountId}&redirect=https://example.com&api_key=${application.api_key}`,
        )
        .set('Authorization', `Bearer ${host.jwt()}`);

      configPaypalStub.restore();
      expect(res.status).to.equal(404);
      expect(res.body.error).to.equal('PayPal Connect is not available at the moment.');
    });

    it('returns 401 when not authenticated', async () => {
      configPaypalStub = stub(config, 'paypal').get(() => ({ connect: connectConfig }));

      const accountId = idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT);
      const res = await request(expressApp).get(
        `/connected-accounts/paypal/connect-config?accountId=${accountId}&redirect=https://example.com&api_key=${application.api_key}`,
      );

      configPaypalStub.restore();
      expect(res.status).to.equal(401);
    });

    it('returns 400 when accountId is missing', async () => {
      configPaypalStub = stub(config, 'paypal').get(() => ({ connect: connectConfig }));

      const res = await request(expressApp)
        .get(`/connected-accounts/paypal/connect-config?redirect=https://example.com&api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`);

      configPaypalStub.restore();
      expect(res.status).to.equal(400);
    });

    it('returns 400 when redirect is missing', async () => {
      configPaypalStub = stub(config, 'paypal').get(() => ({ connect: connectConfig }));

      const accountId = idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT);
      const res = await request(expressApp)
        .get(`/connected-accounts/paypal/connect-config?accountId=${accountId}&api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`);

      configPaypalStub.restore();
      expect(res.status).to.equal(400);
    });

    it('returns 404 when collective not found', async () => {
      configPaypalStub = stub(config, 'paypal').get(() => ({ connect: connectConfig }));

      const fakeAccountId = idEncode(999999, IDENTIFIER_TYPES.ACCOUNT);
      const res = await request(expressApp)
        .get(
          `/connected-accounts/paypal/connect-config?accountId=${fakeAccountId}&redirect=https://example.com&api_key=${application.api_key}`,
        )
        .set('Authorization', `Bearer ${host.jwt()}`);

      configPaypalStub.restore();
      expect(res.status).to.equal(404);
    });

    it('returns 403 when user is not admin of collective', async () => {
      configPaypalStub = stub(config, 'paypal').get(() => ({ connect: connectConfig }));

      const accountId = idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT);
      const res = await request(expressApp)
        .get(
          `/connected-accounts/paypal/connect-config?accountId=${accountId}&redirect=https://example.com&api_key=${application.api_key}`,
        )
        .set('Authorization', `Bearer ${user.jwt()}`);

      configPaypalStub.restore();
      expect(res.status).to.equal(403);
    });

    it('returns 200 with clientId, redirectUri, authorizeUrl when admin', async () => {
      configPaypalStub = stub(config, 'paypal').get(() => ({
        connect: connectConfig,
        payment: { environment: 'sandbox' },
      }));

      const accountId = idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT);
      const res = await request(expressApp)
        .get(
          `/connected-accounts/paypal/connect-config?accountId=${accountId}&redirect=https://example.com&api_key=${application.api_key}`,
        )
        .set('Authorization', `Bearer ${host.jwt()}`);

      configPaypalStub.restore();
      expect(res.status).to.equal(200);
      expect(res.body.clientId).to.equal(connectConfig.clientId);
      expect(res.body.redirectUri).to.equal(connectConfig.redirectUri);
      expect(res.body.authorizeUrl).to.include(`client_id=${connectConfig.clientId}`);
      expect(res.body.authorizeUrl).to.include('response_type=code');
    });
  });

  const createPaypalConnectState = (collectiveId, userId) =>
    jwt.sign(
      { CollectiveId: collectiveId, userId, redirect: null, currency: 'USD' },
      config.keys.opencollective.jwtSecret,
      { expiresIn: '30m' },
    );

  describe('POST /connected-accounts/paypal/connect', () => {
    beforeEach(() => {
      configPaypalStub = stub(config, 'paypal').get(() => ({
        connect: connectConfig,
        payment: { environment: 'sandbox' },
      }));
    });

    afterEach(() => {
      if (configPaypalStub) {
        configPaypalStub.restore();
      }
      nock.cleanAll();
    });

    const validBody = {
      code: 'paypal-auth-code-123',
      accountId: '',
      currency: 'USD',
      name: 'My PayPal',
    };

    const getValidBodyWithState = () => ({
      ...validBody,
      accountId: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT),
      state: createPaypalConnectState(collective.id, host.id),
    });

    it('returns 401 when not authenticated', async () => {
      const body = getValidBodyWithState();
      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(401);
    });

    it('returns 400 when state is missing', async () => {
      const body = getValidBodyWithState();
      const bodyWithoutState = omit(body, 'state');

      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(bodyWithoutState);

      expect(res.status).to.equal(400);
      expect(res.body.error?.message || res.body.message || '').to.include('OAuth state');
    });

    it('returns 400 when state is invalid or expired', async () => {
      const body = getValidBodyWithState();
      body.state = 'invalid-state-token';

      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(400);
      expect(res.body.error?.message || res.body.message || '').to.include('invalid or expired');
    });

    it('returns 403 when state CollectiveId does not match accountId', async () => {
      const body = getValidBodyWithState();
      const otherCollectiveId = collective.id + 9999;
      body.state = createPaypalConnectState(otherCollectiveId, host.id);

      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(403);
      expect(res.body.error?.message || res.body.message || '').to.include('does not match the requested account');
    });

    it('returns 403 when state userId does not match current user', async () => {
      const body = getValidBodyWithState();
      body.state = createPaypalConnectState(collective.id, user.id);

      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(403);
      expect(res.body.error?.message || res.body.message || '').to.include('does not match the current user');
    });

    it('returns 400 when code is missing', async () => {
      const body = getValidBodyWithState();
      const bodyWithoutCode = omit(body, 'code');

      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(bodyWithoutCode);

      expect(res.status).to.equal(400);
      expect(res.body.error?.message || res.body.message || '').to.include('PayPal code');
    });

    it('returns 400 when accountId is missing', async () => {
      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send({ code: 'abc', currency: 'USD' });

      expect(res.status).to.equal(400);
    });

    it('returns 400 when currency is missing', async () => {
      const body = getValidBodyWithState();
      const bodyWithoutCurrency = omit(body, 'currency');

      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(bodyWithoutCurrency);

      expect(res.status).to.equal(400);
    });

    it('returns 404 when collective not found', async () => {
      const body = {
        code: 'abc',
        state: createPaypalConnectState(999999, host.id),
        accountId: idEncode(999999, IDENTIFIER_TYPES.ACCOUNT),
        currency: 'USD',
      };

      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(404);
    });

    it('returns 403 when user is not admin of collective', async () => {
      const body = getValidBodyWithState();
      body.state = createPaypalConnectState(collective.id, user.id);

      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${user.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(403);
    });

    it('creates ConnectedAccount and PayoutMethod on success', async () => {
      const tokenResponse = {
        access_token: 'user-access-token',
        refresh_token: 'user-refresh-token',
        token_type: 'Bearer',
        expires_in: 28800,
      };
      const userInfo = {
        user_id: 'PAYER123',
        sub: 'sub-123',
        name: 'John Doe',
        payer_id: 'PAYER123',
        address: {
          street_address: '123 Main St',
          locality: 'San Jose',
          region: 'CA',
          postal_code: '95131',
          country: 'US',
        },
        verified_account: 'true',
        emails: [{ value: 'john@example.com', primary: true, confirmed: true }],
      };

      ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl => {
        nock(baseUrl).post('/v1/oauth2/token').reply(200, tokenResponse);
        nock(baseUrl).get('/v1/identity/oauth2/userinfo').query(true).reply(200, userInfo);
      });

      const body = getValidBodyWithState();
      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(200);
      expect(res.body.connectedAccountId).to.be.a('string');
      expect(res.body.payoutMethodId).to.be.a('string');

      const connectedAccount = await models.ConnectedAccount.findOne({
        where: { CollectiveId: collective.id, service: 'paypal' },
      });
      expect(connectedAccount).to.exist;
      expect(connectedAccount.username).to.equal('john@example.com');
      expect(connectedAccount.token).to.equal('user-access-token');

      const payoutMethod = await models.PayoutMethod.findOne({
        where: { CollectiveId: collective.id, type: PayoutMethodTypes.PAYPAL },
      });
      expect(payoutMethod).to.exist;
      expect(payoutMethod.data?.email).to.equal('john@example.com');
    });

    it('returns error when PayPal account has no confirmed email', async () => {
      const tokenResponse = {
        access_token: 'user-access-token',
        refresh_token: 'user-refresh-token',
        token_type: 'Bearer',
        expires_in: 28800,
      };
      const userInfoNoEmail = {
        user_id: 'PAYER123',
        verified_account: 'true',
        emails: [{ value: 'unconfirmed@example.com', primary: true, confirmed: false }],
      };

      ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl => {
        nock(baseUrl).post('/v1/oauth2/token').reply(200, tokenResponse);
        nock(baseUrl).get('/v1/identity/oauth2/userinfo').query(true).reply(200, userInfoNoEmail);
      });

      const body = getValidBodyWithState();
      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(400);
      expect(res.body.error?.message || res.body.message || '').to.include('confirmed email');
    });

    it('returns error when PayPal account is not verified', async () => {
      const tokenResponse = {
        access_token: 'user-access-token',
        refresh_token: 'user-refresh-token',
        token_type: 'Bearer',
        expires_in: 28800,
      };
      const userInfoUnverified = {
        user_id: 'PAYER123',
        verified_account: 'false',
        emails: [{ value: 'verified@example.com', primary: true, confirmed: true }],
      };

      ['https://api.sandbox.paypal.com', 'https://api.paypal.com'].forEach(baseUrl => {
        nock(baseUrl).post('/v1/oauth2/token').reply(200, tokenResponse);
        nock(baseUrl).get('/v1/identity/oauth2/userinfo').query(true).reply(200, userInfoUnverified);
      });

      const body = getValidBodyWithState();
      const res = await request(expressApp)
        .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(res.status).to.equal(400);
      expect(res.body.error?.message || res.body.message || '').to.include('not verified');
    });
  });
});
