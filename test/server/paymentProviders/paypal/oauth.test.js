import { expect } from 'chai';
import config from 'config';
import express from 'express';
import { stub } from 'sinon';
import request from 'supertest';

import { idEncode, IDENTIFIER_TYPES } from '../../../../server/graphql/v2/identifiers';
import setupExpress from '../../../../server/lib/express';
import routes from '../../../../server/routes';
import { fakeCollective, fakeUser } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const application = utils.data('application');

/**
 * The REST endpoints were replaced by the `getPaypalOAuthUrl` and `connectPaypalPayoutMethod` GraphQL mutations.
 * See `test/server/graphql/v2/mutation/PaypalMutations.test.ts`.
 */
describe('server/paymentProviders/paypal/oauth (deprecated REST)', () => {
  let host, collective, expressApp, configPaypalStub;

  before(async () => {
    expressApp = express();
    setupExpress(expressApp);
    await routes(expressApp);
  });

  beforeEach(async () => {
    await utils.resetTestDB();
    host = await fakeUser();
    collective = await fakeCollective({ admin: host });
    configPaypalStub = stub(config, 'paypal').get(() => ({
      connect: { clientId: 'test-paypal-connect-client-id', redirectUri: 'https://example.com/callback' },
      payment: { environment: 'sandbox' },
    }));
  });

  afterEach(() => {
    configPaypalStub.restore();
  });

  it('GET /connected-accounts/paypal/connect-config returns 410', async () => {
    const accountId = idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT);
    const res = await request(expressApp)
      .get(
        `/connected-accounts/paypal/connect-config?accountId=${accountId}&redirect=https://example.com&api_key=${application.api_key}`,
      )
      .set('Authorization', `Bearer ${host.jwt()}`);

    expect(res.status).to.equal(410);
    expect(res.body.error.message).to.include('Please reload the page');
  });

  it('POST /connected-accounts/paypal/connect returns 410', async () => {
    const res = await request(expressApp)
      .post(`/connected-accounts/paypal/connect?api_key=${application.api_key}`)
      .set('Authorization', `Bearer ${host.jwt()}`)
      .set('Content-Type', 'application/json')
      .send({
        code: 'abc',
        state: 'xyz',
        accountId: idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT),
        currency: 'USD',
      });

    expect(res.status).to.equal(410);
    expect(res.body.error.message).to.include('Please reload the page');
  });
});
