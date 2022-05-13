import request from 'supertest';

import { fakeApplication, fakeUser } from '../../test-helpers/fake-data';
import { startTestServer, stopTestServer } from '../../test-helpers/server';

describe('server/routes/oauth', () => {
  let expressApp;

  before(async () => {
    expressApp = await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  it('goes through the entire OAuth flow', async () => {
    const application = await fakeApplication();

    console.log(
      `curl -L -v -H "Authorization: Bearer ${application.createdByUser.jwt()}" -X POST \"http://localhost:3060/oauth/authorize?response_type=code&client_id=${
        application.clientId
      }\"`,
    );
    // Get authorization code
    const authorizeResponse = await request(expressApp)
      .post(`/oauth/authorize?response_type=code&client_id=${application.clientId}`)
      .set('Content-Type', `application/x-www-form-urlencoded`)
      .set('Authorization', `Bearer ${application.createdByUser.jwt()}`)
      .redirects(0)
      .expect(301);

    console.log({ authorizeResponse });
    // TODO const redirectUrl = new URL(authorizeResponse.???);
    // const redirectUrl = new URL('http://localhost:3000/oauth/authorize?code=xxxxxxxxxxxxxxxx');
    // const code = redirectUrl.searchParams.get('code');

    // // Swap authorization code for access token
    // const tokenResponse = await request(expressApp)
    //   .post(`/oauth/token?authorization_code=${code}`)
    //   .set('Authorization', `Bearer ${application.createdByUser.jwt()}`)
    //   .set('Accept', 'application/json')
    //   .expect(200);

    // const token = tokenResponse.???

    // Swap refresh token for access token
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
});
