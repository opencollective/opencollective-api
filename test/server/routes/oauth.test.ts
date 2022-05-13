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
      .expect(res => {
        if (res.status !== 302) {
          throw new Error(JSON.stringify(res.body, null, 2));
        }
      });

    const redirectUri = new URL(authorizeResponse.headers.location);
    const code = redirectUri.searchParams.get('code');
    const tokenResponse = await request(expressApp)
      .post(`/oauth/token`)
      .set('Authorization', `Bearer ${application.createdByUser.jwt()}`)
      .set('Accept', 'application/json')
      .type(`application/x-www-form-urlencoded`)
      .send({
        /* eslint-disable camelcase */
        grant_type: 'authorization_code',
        code,
        client_id: application.clientId,
        // TODO client_secret: application.clientSecret,
        redirect_uri: authorizeResponse.headers.location.toString(),
        /* eslint-enable camelcase */
      })
      .expect(res => {
        if (res.status !== 200) {
          throw new Error(JSON.stringify(res.body, null, 2));
        }
      });

    // console.log({ tokenResponse });
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
