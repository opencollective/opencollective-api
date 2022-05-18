import { expect } from 'chai';
import config from 'config';
import jwt from 'jsonwebtoken';
import { useFakeTimers } from 'sinon';
import request from 'supertest';

import { fakeApplication, fakeUser } from '../../test-helpers/fake-data';
import { startTestServer, stopTestServer } from '../../test-helpers/server';
import { resetTestDB } from '../../utils';

describe('server/routes/oauth', () => {
  let expressApp, clock;

  before(async () => {
    await resetTestDB();
    expressApp = await startTestServer();
  });

  after(async () => {
    await stopTestServer();
    if (clock) {
      clock.restore();
    }
  });

  it('goes through the entire OAuth flow', async () => {
    const fakeNow = new Date(2022, 0, 1);
    clock = useFakeTimers(fakeNow);
    const application = await fakeApplication();

    // Get authorization code
    const authorizeParams = new URLSearchParams({
      /* eslint-disable camelcase */
      response_type: 'code',
      client_id: application.clientId,
      client_secret: application.clientSecret,
      redirect_uri: application.callbackUrl,
      /* eslint-enable camelcase */
    });

    const authorizeResponse = await request(expressApp)
      .post(`/oauth/authorize?${authorizeParams.toString()}`)
      .set('Content-Type', `application/x-www-form-urlencoded`)
      .set('Authorization', `Bearer ${application.createdByUser.jwt()}`)
      .redirects(0)
      .expect(res => {
        if (res.status !== 302) {
          throw new Error(JSON.stringify(res.body, null, 2));
        }
      });

    // Exchange authorization code for access token
    const redirectUri = new URL(authorizeResponse.headers.location);
    const code = redirectUri.searchParams.get('code');
    const tokenResponse = await request(expressApp)
      .post(`/oauth/token`)
      .set('Authorization', `Bearer ${application.createdByUser.jwt()}`)
      .type(`application/x-www-form-urlencoded`)
      .send({
        /* eslint-disable camelcase */
        grant_type: 'authorization_code',
        code,
        client_id: application.clientId,
        client_secret: application.clientSecret,
        redirect_uri: application.callbackUrl,
        /* eslint-enable camelcase */
      })
      .expect(res => {
        if (res.status !== 200) {
          throw new Error(JSON.stringify(res.body, null, 2));
        }
      });

    // Decode returned OAuth token
    const oauthToken = tokenResponse.res.text;
    expect(oauthToken).to.exist;

    const decodedToken = jwt.verify(oauthToken, config.keys.opencollective.jwtSecret);
    expect(decodedToken.sub).to.eq(application.CreatedByUserId.toString());
    expect(decodedToken.access_token.startsWith('test_oauth_')).to.be.true;
    expect(decodedToken.iat).to.eq(fakeNow.getTime() / 1000); // 1640995200
    expect(decodedToken.exp).to.eq(1648771200);

    // Test OAuth token with a real query
    const gqlRequestResult = await request(expressApp)
      .post('/graphql/v2')
      .set('Authorization', `Bearer ${oauthToken}`)
      .accept('application/json')
      .send({
        query: '{ loggedInAccount { legacyId } }',
      });

    const jsonResponse = JSON.parse(gqlRequestResult.res.text);
    const loggedInAccount = jsonResponse.data.loggedInAccount;
    expect(loggedInAccount.legacyId).to.eq(application.CreatedByUserId);
  });

  describe('authorize', () => {
    it('must provide a client_id', async () => {
      await request(expressApp).post('/oauth/authorize?response_type=code').expect(400);
    });

    it('must be authenticated', async () => {
      await request(expressApp).post('/oauth/authorize?response_type=code&client_id=nope').expect(401);
    });

    it('must provide a valid JWT authentication token', async () => {
      await request(expressApp)
        .post('/oauth/authorize?response_type=code&client_id=nope')
        .set('Authorization', `Bearer NOT A VALID JWT`)
        .expect(401);
    });

    it('must be an admin of the requested client', async () => {
      const application = await fakeApplication();
      const randomUser = await fakeUser();
      await request(expressApp)
        .post(`/oauth/authorize?response_type=code&client_id=${application.clientId}`)
        .set('Authorization', `Bearer ${randomUser.jwt()}`)
        .expect(403);
    });
  });

  // describe('token', () => {
  //   it('must provide a client_id', async () => {});
  // });
});
