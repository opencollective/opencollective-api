/* eslint-disable camelcase */
import { expect } from 'chai';
import config from 'config';
import express from 'express';
import { stub } from 'sinon';
import request from 'supertest';

import setupExpress from '../../../../server/lib/express';
import routes from '../../../../server/routes';
import { fakeCollective, fakeUser } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const application = utils.data('application');

describe('server/paymentProviders/paypal/oauth (deprecated REST)', () => {
  let host, expressApp, configPaypalStub;

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
    await fakeCollective({ admin: host });
    configPaypalStub = stub(config, 'paypal').get(() => ({
      connect: connectConfig,
      payment: { environment: 'sandbox' },
    }));
  });

  afterEach(() => {
    configPaypalStub.restore();
  });

  it('GET /connected-accounts/paypal/connect-config returns 401 (deprecated)', async () => {
    const res = await request(expressApp)
      .get(`/connected-accounts/paypal/connect-config?api_key=${application.api_key}`)
      .set('Authorization', `Bearer ${host.jwt()}`);

    expect(res.status).to.equal(401);
  });

  it('POST /connected-accounts/paypal/connect returns 401 (deprecated)', async () => {
    const res = await request(expressApp)
      .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
      .set('Authorization', `Bearer ${host.jwt()}`)
      .set('Content-Type', 'application/json')
      .send({ code: 'abc', state: 'xyz', accountId: '1', currency: 'USD' });

    expect(res.status).to.equal(401);
  });
});
