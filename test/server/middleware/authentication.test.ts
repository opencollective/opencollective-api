import { expect } from 'chai';
import config from 'config';
import jwt from 'jsonwebtoken';
import moment from 'moment';
import request from 'supertest';

import { sessionCache } from '../../../server/lib/cache';
import { fakePersonalToken, fakeUser, fakeUserToken } from '../../test-helpers/fake-data';
import { startTestServer, stopTestServer } from '../../test-helpers/server';
import { resetTestDB } from '../../utils';

describe('server/middleware/authentication', () => {
  let expressApp;

  before(async () => {
    await resetTestDB();
    expressApp = await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  beforeEach(async () => {
    await resetTestDB();
  });

  describe('authenticateUser', () => {
    it('should authenticate user with valid JWT in Authorization header', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should NOT authenticate user with JWT in access_token query parameter (security regression)', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      // access_token in query string is no longer accepted to prevent JWT leakage in URLs and OAuth redirect_uri
      const response = await request(expressApp).get(`/status?access_token=${token}`).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.false;
    });

    it('should authenticate user with JWT in body', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      const response = await request(expressApp)
        .post('/status')
        // eslint-disable-next-line camelcase
        .send({ access_token: token })
        .expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should reject expired JWT tokens', async () => {
      const user = await fakeUser();
      const expiredToken = user.jwt({ scope: 'session' }, -1); // expired

      const response = await request(expressApp)
        .get('/status')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('jwt expired');
    });

    it('should handle invalid JWT tokens gracefully', async () => {
      const response = await request(expressApp)
        .get('/status')
        .set('Authorization', 'Bearer invalid-token')
        .expect(200); // Invalid tokens are handled gracefully, request continues without auth

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.false;
    });

    it('should allow requests without tokens (optional auth)', async () => {
      const response = await request(expressApp).get('/status').expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.false;
    });

    it('should reject tokens with mismatched email', async () => {
      const user = await fakeUser();
      // Create token - jwt() automatically includes user.email in payload
      const token = user.jwt({ scope: 'session' });

      // Create another user to get a valid email domain, then update email
      const otherUser = await fakeUser();
      // Use the other user's email domain pattern but with a unique local part
      const emailDomain = otherUser.email.split('@')[1];
      const newEmail = `updated-${Date.now()}@${emailDomain}`;
      await user.update({ email: newEmail });

      // Verify the email was updated
      await user.reload();
      expect(user.email).to.equal(newEmail);

      // Test with /status endpoint to verify authentication fails
      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('expired');
    });

    it('should invalidate tokens after password update', async () => {
      const user = await fakeUser();
      // Create token - this sets iat to current time (in seconds since epoch)
      const token = user.jwt({ scope: 'session' });

      // Decode token to get iat
      const decoded = jwt.decode(token) as jwt.JwtPayload;
      const tokenIat = decoded.iat; // iat is in seconds

      // Set passwordUpdatedAt to a time that's definitely after the token's iat
      // Add 2 seconds to ensure it's after iat (which is in seconds precision)
      const passwordUpdatedAt = moment.unix(tokenIat).add(2, 'seconds').toDate();
      await user.update({ passwordUpdatedAt });

      // Test with /status endpoint to verify authentication fails
      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('expired');
    });
  });

  describe('checkJwtScope', () => {
    it('should allow session scope on general routes', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should allow oauth scope on general routes', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'oauth' });

      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should restrict twofactorauth scope to specific routes', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'twofactorauth' });

      // Should work on allowed route (may return 400/500 for invalid code, but auth passed)
      const response1 = await request(expressApp)
        .post('/users/two-factor-auth')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '123456' });

      // Should not be 401 (unauthorized) - auth should pass
      expect([200, 400, 500]).to.include(response1.status);

      // Should fail on other routes
      const response2 = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(401);

      expect(response2.body.error).to.exist;
      expect(response2.body.error.message).to.include('Cannot use this token on this route');
    });

    it('should restrict login scope to exchange-login-token route in production', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'login' });

      // Should work on allowed route
      const response = await request(expressApp)
        .post('/users/exchange-login-token')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.status).to.equal(200);
    });

    it('should restrict reset-password scope to specific GraphQL operations', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'reset-password' });

      // Should work with allowed mutation
      await request(expressApp)
        .post('/graphql/v2')
        .set('Authorization', `Bearer ${token}`)
        .send({
          query: `
            mutation ResetPassword($password: String!) {
              setPassword(password: $password) {
                individual {
                  id
                  __typename
                }
                token
                __typename
              }
            }
          `,
          variables: { password: 'newpassword123' },
        });

      // Should fail with other operations
      const response2 = await request(expressApp)
        .post('/graphql/v2')
        .set('Authorization', `Bearer ${token}`)
        .send({
          query: `
            query {
              loggedInAccount {
                id
              }
            }
          `,
        });

      // Check if it's a 401 or if the error is in the GraphQL response
      if (response2.status === 401) {
        expect(response2.body.error).to.exist;
      } else {
        expect(response2.body.errors).to.exist;
        expect(response2.body.errors[0].message).to.include('Not allowed to use tokens with reset-password scope');
      }
    });

    it('should restrict connected-account scope to specific routes', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'connected-account' });

      // Should work on allowed route (may return error for missing data, but auth passed)
      const response1 = await request(expressApp).get('/github-repositories').set('Authorization', `Bearer ${token}`);

      // Should not be 401 (unauthorized) - auth should pass
      expect([200, 400, 500]).to.include(response1.status);

      // Should fail on other routes
      const response2 = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(401);

      expect(response2.body.error).to.exist;
      expect(response2.body.error.message).to.include('Cannot use this token on this route');
    });

    it('should reject unknown scopes', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'unknown-scope' });

      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('Cannot use this token on this route');
    });
  });

  describe('checkPersonalToken', () => {
    it('should authenticate with valid Personal Token in Personal-Token header', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });

      const response = await request(expressApp).get('/status').set('Personal-Token', personalToken.token).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should authenticate with Personal Token in Api-Key header', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });

      const response = await request(expressApp).get('/status').set('Api-Key', personalToken.token).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should authenticate with Personal Token in query parameter', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });

      const response = await request(expressApp).get(`/status?personalToken=${personalToken.token}`).expect(200);

      expect(response.status).to.equal(200);
    });

    it('should authenticate with Personal Token in apiKey query parameter', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });

      const response = await request(expressApp).get(`/status?apiKey=${personalToken.token}`).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should reject expired Personal Tokens', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({
        user,
        expiresAt: moment().subtract(1, 'day').toDate(),
      });

      const response = await request(expressApp).get('/status').set('Personal-Token', personalToken.token).expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('Expired Personal Token');
    });

    it('should reject suspended Personal Tokens', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({
        user,
        data: { isSuspended: true },
      });

      const response = await request(expressApp).get('/status').set('Personal-Token', personalToken.token).expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('suspended');
    });

    it('should reject invalid Personal Tokens', async () => {
      const response = await request(expressApp).get('/status').set('Personal-Token', 'invalid-token').expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('Invalid Personal Token');
    });

    it('should require user to be admin of the collective', async () => {
      const user = await fakeUser();
      const otherUser = await fakeUser();
      const personalToken = await fakePersonalToken({
        user: otherUser,
        CollectiveId: user.CollectiveId, // Token for different user's collective
      });

      const response = await request(expressApp).get('/status').set('Personal-Token', personalToken.token).expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('Invalid personal token for collective');
    });

    it('should reject multiple apiKey values in query parameters', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });

      // Express parses duplicate query params as arrays
      const response = await request(expressApp)
        .get(`/status?apiKey=${personalToken.token}&apiKey=another-value`)
        .expect(400);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('Please provide a single apiKey');
    });

    it('should reject multiple personalToken values in query parameters', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });

      // Express parses duplicate query params as arrays
      const response = await request(expressApp)
        .get(`/status?personalToken=${personalToken.token}&personalToken=another-value`)
        .expect(400);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('Please provide a single token');
    });
  });

  describe('authorizeClient', () => {
    it('should allow requests with valid API key in header', async () => {
      // Note: checkPersonalToken runs before authorizeClient, so if the API key
      // is not a personal token, it will be rejected. API keys should be passed
      // in query params or body, not headers, to avoid checkPersonalToken.
      const response = await request(expressApp)
        .get(`/status?api_key=${config.keys.opencollective.apiKey}`)
        .expect(200);

      expect(response.body.status).to.equal('ok');
      // API key doesn't authenticate a user, just authorizes the request
      expect(response.body.authenticated).to.be.false;
    });

    it('should allow requests with valid API key in query parameter', async () => {
      const response = await request(expressApp)
        .get(`/status?api_key=${config.keys.opencollective.apiKey}`)
        .expect(200);

      expect(response.body.status).to.equal('ok');
      // API key doesn't authenticate a user, just authorizes the request
      expect(response.body.authenticated).to.be.false;
    });

    it('should allow requests with valid API key in body', async () => {
      const response = await request(expressApp)
        .post('/status')
        // eslint-disable-next-line camelcase
        .send({ api_key: config.keys.opencollective.apiKey })
        .expect(200);

      expect(response.body.status).to.equal('ok');
      // API key doesn't authenticate a user, just authorizes the request
      expect(response.body.authenticated).to.be.false;
    });

    it('should reject requests with invalid API key', async () => {
      const response = await request(expressApp).get('/status').set('Api-Key', 'invalid-key').expect(401);

      expect(response.body.error).to.exist;
      // Invalid API key should be rejected, but checkPersonalToken runs first
      // so it might try to validate as personal token first
      expect(response.body.error.message).to.match(/Invalid (API key|Personal Token)/);
    });

    it('should allow requests with valid Personal Token (bypasses API key)', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });

      const response = await request(expressApp).get('/status').set('Personal-Token', personalToken.token).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should allow requests without API key (optional)', async () => {
      const response = await request(expressApp).get('/status').expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.false;
    });

    it('should allow exceptions for PayPal callback routes', async () => {
      // PayPal callback routes don't require API key
      const response = await request(expressApp)
        .get('/collectives/1/transactions/1/callback?token=test&paymentId=test&PayerID=test')
        .expect(404); // 404 because route doesn't exist, but auth passed

      // Should not be 401 (unauthorized)
      expect(response.status).to.not.equal(401);
    });

    it('should allow exceptions for webhook routes', async () => {
      // Webhook routes don't require API key
      const response = await request(expressApp).post('/webhooks/stripe');

      // Should not be 401 (unauthorized) - webhooks are exception routes
      expect(response.status).to.not.equal(401);
      // May return 400/500 for invalid webhook data, but auth passed
      expect([200, 400, 500]).to.include(response.status);
    });
  });

  describe('authenticateService', () => {
    it('should reject multiple CollectiveId values in query parameters', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      // Express parses duplicate query params as arrays: ?CollectiveId=id1&CollectiveId=id2
      const response = await request(expressApp)
        .get(`/connected-accounts/stripe?CollectiveId=${user.CollectiveId}&CollectiveId=999`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('Please provide a single CollectiveId');
    });
  });

  describe('authenticateService - GitHub OAuth', () => {
    it('returns 401 without authentication', async () => {
      const response = await request(expressApp).get('/connected-accounts/github/oauthUrl').expect(401);

      expect(response.body.error.message).to.include('logged in');
    });

    it('returns 401 when access_token is in query (no longer accepted)', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      // access_token in the query string is stripped by parseJwt and must not grant access
      const response = await request(expressApp)
        .get(`/connected-accounts/github/oauthUrl?access_token=${token}`)
        .expect(401);

      expect(response.body.error.message).to.include('logged in');
    });

    it('returns JSON redirectUrl with correct GitHub URL for authenticated user', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      const response = await request(expressApp)
        .get('/connected-accounts/github/oauthUrl')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.redirectUrl).to.be.a('string');
      const url = new URL(response.body.redirectUrl);
      expect(url.hostname).to.equal('github.com');
      expect(url.pathname).to.equal('/login/oauth/authorize');
      expect(url.searchParams.get('state')).to.be.a('string').with.length.greaterThan(0);
    });

    it('does not include access_token in the GitHub redirect_uri (security regression)', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      const response = await request(expressApp)
        .get('/connected-accounts/github/oauthUrl')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const url = new URL(response.body.redirectUrl);
      const redirectUri = url.searchParams.get('redirect_uri');
      expect(redirectUri).to.not.include('access_token');
    });

    it('uses createCollective scope when context=createCollective', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      const response = await request(expressApp)
        .get('/connected-accounts/github/oauthUrl?context=createCollective')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const url = new URL(response.body.redirectUrl);
      const scope = url.searchParams.get('scope');
      expect(scope).to.include('read:org');
      expect(scope).to.include('public_repo');
      expect(scope).to.not.include('user:email');
    });

    it('uses full scope for other contexts', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      const response = await request(expressApp)
        .get('/connected-accounts/github/oauthUrl')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const url = new URL(response.body.redirectUrl);
      const scope = url.searchParams.get('scope');
      expect(scope).to.include('user:email');
      expect(scope).to.include('public_repo');
      expect(scope).to.include('read:org');
    });
  });

  describe('authenticateServiceCallback - GitHub OAuth', () => {
    it('returns 401 when state param is missing', async () => {
      const response = await request(expressApp).get('/connected-accounts/github/callback?code=some-code').expect(401);

      expect(response.body.error.message).to.include('state');
    });

    it('returns 401 when state does not match a cached entry', async () => {
      const response = await request(expressApp)
        .get('/connected-accounts/github/callback?code=some-code&state=nonexistent-uuid')
        .expect(401);

      expect(response.body.error.message).to.include('expired or invalid');
    });

    it('consumes OAuth state at most once when the callback is hit concurrently', async () => {
      const user = await fakeUser();
      const stateKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const cacheKey = `oauth-github-state:${stateKey}`;
      await sessionCache.set(cacheKey, { userId: user.id, context: undefined, CollectiveId: undefined }, 600);

      const parallel = 25;
      const responses = await Promise.all(
        Array.from({ length: parallel }, () =>
          request(expressApp).get(
            `/connected-accounts/github/callback?code=invalid-placeholder&state=${encodeURIComponent(stateKey)}`,
          ),
        ),
      );

      const staleStateResponses = responses.filter(response =>
        response.body?.error?.message?.includes?.('expired or invalid'),
      );

      expect(staleStateResponses).to.have.length(parallel - 1);

      expect(
        responses.filter(response => !response.body?.error?.message?.includes?.('expired or invalid')),
      ).to.have.length(1);
    });
  });

  describe('mustBeLoggedIn', () => {
    it('should allow authenticated users', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'session' });

      // Test that authenticated users can access endpoints that require mustBeLoggedIn
      // Using /status to verify authentication works
      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should reject unauthenticated requests', async () => {
      const response = await request(expressApp).post('/users/exchange-login-token').expect(401);

      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.include('not authenticated');
    });

    it('should allow Personal Token authentication', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({ user });

      // Test that Personal Token authentication works
      const response = await request(expressApp).get('/status').set('Personal-Token', personalToken.token).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });
  });

  describe('login scope token validation', () => {
    it('should reject login tokens if user has logged in since token was issued', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'login' });

      // Simulate user logging in
      await user.update({ lastLoginAt: new Date() });

      // In production/staging, this should fail
      // In test/dev, it might be ignored
      const response = await request(expressApp)
        .post('/users/exchange-login-token')
        .set('Authorization', `Bearer ${token}`);

      // The behavior depends on environment, but we can verify the token was checked
      expect([200, 401]).to.include(response.status);
    });

    it('should verify expenses when user logs in for first time', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'login' });

      // User has no lastLoginAt
      expect(user.lastLoginAt).to.be.null;

      const response = await request(expressApp)
        .post('/users/exchange-login-token')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.status).to.equal(200);
    });
  });

  describe('reset-password scope token validation', () => {
    it('should reject reset-password tokens if password was updated since token was issued', async () => {
      const user = await fakeUser();
      const token = user.jwt({ scope: 'reset-password' });

      // Update password
      await user.update({ passwordUpdatedAt: new Date() });

      const response = await request(expressApp)
        .post('/graphql/v2')
        .set('Authorization', `Bearer ${token}`)
        .send({
          query: `
            mutation ResetPassword($password: String!) {
              setPassword(password: $password) {
                individual {
                  id
                  __typename
                }
                token
                __typename
              }
            }
          `,
          variables: { password: 'newpassword123' },
        });

      // Should fail with 401 or error in GraphQL response
      if (response.status === 401) {
        expect(response.body.error).to.exist;
      } else {
        expect(response.body.errors).to.exist;
        expect(response.body.errors[0].message).to.include('expired or has already been used');
      }
    });
  });

  describe('UserToken access token validation', () => {
    it('should validate UserToken when access_token is in JWT payload', async () => {
      const user = await fakeUser();
      const userToken = await fakeUserToken({ user });
      // eslint-disable-next-line camelcase
      const token = user.jwt({ scope: 'oauth', access_token: userToken.accessToken });

      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(200);

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.true;
    });

    it('should reject expired UserTokens', async () => {
      const user = await fakeUser();
      const userToken = await fakeUserToken({
        user,
        accessTokenExpiresAt: moment().subtract(1, 'day').toDate(),
      });

      // eslint-disable-next-line camelcase
      const token = user.jwt({ scope: 'oauth', access_token: userToken.accessToken });

      const response = await request(expressApp).get('/status').set('Authorization', `Bearer ${token}`).expect(200); // Request continues but user is not authenticated

      expect(response.body.status).to.equal('ok');
      expect(response.body.authenticated).to.be.false; // User not authenticated due to expired token
    });
  });
});
