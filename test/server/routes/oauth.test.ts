/* eslint-disable camelcase */
import { expect } from 'chai';
import config from 'config';
import jwt from 'jsonwebtoken';
import { useFakeTimers } from 'sinon';
import request from 'supertest';

import { fakeApplication, fakeOAuthAuthorizationCode, fakeUser } from '../../test-helpers/fake-data';
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
  });

  afterEach(() => {
    if (clock) {
      clock.restore();
      clock = null;
    }
  });

  it('goes through the entire OAuth flow', async () => {
    const fakeNow = new Date(2022, 0, 1);
    clock = useFakeTimers(fakeNow);
    const application = await fakeApplication();

    // Get authorization code
    const authorizeParams = new URLSearchParams({
      response_type: 'code',
      client_id: application.clientId,
      client_secret: application.clientSecret,
      redirect_uri: application.callbackUrl,
    });

    const authorizeResponse = await request(expressApp)
      .post(`/oauth/authorize?${authorizeParams.toString()}`)
      .set('Content-Type', `application/x-www-form-urlencoded`)
      .set('Authorization', `Bearer ${application.createdByUser.jwt()}`)
      .expect(200);

    // Exchange authorization code for access token
    const redirectUri = new URL(authorizeResponse.body['redirect_uri']);
    const code = redirectUri.searchParams.get('code');
    const tokenResponse = await request(expressApp)
      .post(`/oauth/token`)
      .type(`application/x-www-form-urlencoded`)
      .send({
        grant_type: 'authorization_code',
        code,
        client_id: application.clientId,
        client_secret: application.clientSecret,
        redirect_uri: application.callbackUrl,
      })
      .expect(res => {
        if (res.status !== 200) {
          throw new Error(JSON.stringify(res.body, null, 2));
        }
      });

    // Decode returned OAuth token
    const oauthToken = tokenResponse.body.access_token;
    expect(oauthToken).to.exist;

    const decodedToken = jwt.verify(oauthToken, config.keys.opencollective.jwtSecret);
    expect(decodedToken.sub).to.eq(application.CreatedByUserId.toString());
    expect(decodedToken.access_token.startsWith('test_oauth_')).to.be.true;
    const iat = fakeNow.getTime() / 1000;
    expect(decodedToken.iat).to.eq(iat); // 1640995200
    expect(decodedToken.exp).to.eq(iat + 7776000); // 90 days

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
      const response = await request(expressApp).post('/oauth/authorize?response_type=code').expect(400);
      const body = response.body;
      expect(body.error).to.eq('invalid_request');
      expect(body.error_description).to.eq('Missing parameter: `client_id`');
    });

    it('must provide a valid client', async () => {
      const randomUser = await fakeUser();
      const response = await request(expressApp)
        .post('/oauth/authorize?response_type=code&client_id=nope')
        .set('Authorization', `Bearer ${randomUser.jwt()}`)
        .expect(400);

      const body = response.body;
      expect(body.error).to.eq('invalid_client');
      expect(body.error_description).to.eq('Invalid client');
    });

    it('must provide an Authorization token', async () => {
      const application = await fakeApplication({ type: 'oAuth' });
      const response = await request(expressApp)
        .post(`/oauth/authorize?response_type=code&client_id=${application.clientId}`)
        .expect(401);

      // Body myst be empty, see https://datatracker.ietf.org/doc/html/rfc6750#section-3.1:
      // "If the request lacks any authentication information (e.g., the client
      // was unaware that authentication is necessary or attempted using an
      // unsupported authentication method), the resource server SHOULD NOT
      // include an error code or other error information.""
      expect(response.body).to.be.empty;
      expect(response.get('www-authenticate')).to.eq('Bearer realm="service"');
    });

    it('must provide a valid Authorization token', async () => {
      const application = await fakeApplication({ type: 'oAuth' });
      const response = await request(expressApp)
        .post(`/oauth/authorize?response_type=code&client_id=${application.clientId}`)
        .set('Authorization', `Bearer NOT A VALID JWT`)
        .expect(401);

      // Body myst be empty, see https://datatracker.ietf.org/doc/html/rfc6750#section-3.1:
      // "If the request lacks any authentication information (e.g., the client
      // was unaware that authentication is necessary or attempted using an
      // unsupported authentication method), the resource server SHOULD NOT
      // include an error code or other error information.""
      expect(response.body).to.be.empty;
      expect(response.get('www-authenticate')).to.eq('Bearer realm="service"');
    });
  });

  describe('token', () => {
    let authorization, validParams;

    beforeEach(async () => {
      authorization = await fakeOAuthAuthorizationCode();
      validParams = {
        grant_type: 'authorization_code',
        code: authorization.code,
        client_id: authorization.application.clientId,
        client_secret: authorization.application.clientSecret,
        redirect_uri: authorization.application.callbackUrl,
      };
    });

    it('works with valid params', async () => {
      await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send(validParams)
        .expect(200);
    });

    it('invalidates the authorization code', async () => {
      // First request should succeed
      await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send(validParams)
        .expect(200);

      // Second request should fail
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send(validParams)
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_grant',
        error_description: 'Invalid authorization code',
      });
    });

    it('throws if the authorization is expired', async () => {
      await authorization.update({ expiresAt: new Date(Date.now() - 1000000) });
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send(validParams)
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_grant',
        error_description: 'Invalid grant: authorization code has expired',
      });
    });

    it('must provide a client_id', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, client_id: null })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_client',
        error_description: 'Invalid client: cannot retrieve client credentials',
      });
    });

    it('must provide a valid client_id', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, client_id: 'NOPE' })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_client',
        error_description: 'Invalid client',
      });
    });

    it('must provide a client secret', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, client_secret: null })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_client',
        error_description: 'Invalid client: cannot retrieve client credentials',
      });
    });

    it('must provide a valid client secret', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, client_secret: 'NOPE' })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_client',
        error_description: 'Invalid client credentials',
      });
    });

    it('must provide a grant type', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, grant_type: null })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_request',
        error_description: 'Missing parameter: `grant_type`',
      });
    });

    it('must provide a valid grant type', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, grant_type: 'NOPE' })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'unsupported_grant_type',
        error_description: 'Unsupported grant type: `grant_type` is invalid',
      });
    });

    it('must provide a code', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, code: null })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_request',
        error_description: 'Missing parameter: `code`',
      });
    });

    it('must provide a valid code', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, code: 'NOPE' })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_grant',
        error_description: 'Invalid authorization code',
      });
    });

    it('must provide a redirect URI', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, redirect_uri: null })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_request',
        error_description: 'Invalid request: `redirect_uri` is not a valid URI',
      });
    });

    it('must provide a valid redirect URI', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, redirect_uri: 'NOPE' })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_request',
        error_description: 'Invalid request: `redirect_uri` is not a valid URI',
      });
    });

    it('must provide a redirect URI that matches the authorization', async () => {
      const response = await request(expressApp)
        .post('/oauth/token')
        .type(`application/x-www-form-urlencoded`)
        .send({ ...validParams, redirect_uri: 'http://not-the-right-uri.com' })
        .expect(400);

      expect(response.body).to.deep.eq({
        error: 'invalid_request',
        error_description: 'Invalid request: `redirect_uri` is invalid',
      });
    });
  });
});
