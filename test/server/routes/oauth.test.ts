import request from 'supertest';

import { fakeApplication, fakeUser } from '../../test-helpers/fake-data';
import { startTestServer, stopTestServer } from '../../test-helpers/server';
import { resetTestDB } from '../../utils';

describe('server/routes/oauth', () => {
  let expressApp;

  before(async () => {
    await resetTestDB();
    expressApp = await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  it('goes through the entire OAuth flow', async () => {
    const application = await fakeApplication();

    // Get authorization code
    // eslint-disable-next-line camelcase
    const authorizeParams = new URLSearchParams({ response_type: 'code', client_id: application.clientId });
    const authorizeResponse = await request(expressApp)
      .post(`/oauth/authorize?${authorizeParams.toString()}`)
      .set('Content-Type', `application/x-www-form-urlencoded`)
      .set('Authorization', `Bearer ${application.createdByUser.jwt()}`)
      .redirects(0)
      .expect(302);

    const redirectUrl = new URL(authorizeResponse.headers.location);
    const code = redirectUrl.searchParams.get('code');

    // Swap authorization code for access token
    const tokenParams = new URLSearchParams({
      /* eslint-disable camelcase */
      grant_type: 'authorization_code',
      code,
      client_id: application.clientId,
      // TODO client_secret: application.clientSecret,
      // TODO redirect_uri: application.redirectUri,
      /* eslint-enable camelcase */
    });

    const tokenResponse = await request(expressApp)
      .post(`/oauth/token`)
      .set('Authorization', `Bearer ${application.createdByUser.jwt()}`)
      .type(tokenParams.toString())
      .set('Content-Type', `application/x-www-form-urlencoded`)
      .set('Accept', 'application/json')
      .expect(200);

    console.log({ tokenResponse });
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

  describe('token', () => {
    it('must provide a client_id', async () => {});
  });
});
