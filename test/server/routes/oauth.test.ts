import request from 'supertest';

import app from '../../../server/index';
import { sleep } from '../../../server/lib/utils';
import { fakeApplication } from '../../test-helpers/fake-data';

describe('server/routes/oauth', () => {
  let expressApp;

  before(async () => {
    expressApp = await app();
  });

  after(async () => {
    await new Promise(resolve => expressApp.__server__.close(resolve));
  });

  it('goes through the entire OAuth flow', async () => {
    const application = await fakeApplication();

    console.log(
      `curl -L -v -H "Authorization: Bearer ${application.createdByUser.jwt()}" -X POST \"http://localhost:3060/oauth/authorize?response_type=code&client_id=${
        application.clientId
      }\"`,
    );
    // Get authorization code
    await sleep(120000);
    const authorizeResponse = await request(expressApp)
      .post(`/oauth/authorize?response_type=code&client_id=${application.clientId}`)
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
});
