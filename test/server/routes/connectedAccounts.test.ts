import { expect } from 'chai';
import config from 'config';
import request from 'supertest';

import app from '../../../server/index';
import { sessionCache } from '../../../server/lib/cache';
import models from '../../../server/models';
import * as utils from '../../utils';

const clientId = config.github.clientID;
const application = utils.data('application');

describe('server/routes/connectedAccounts', () => {
  let req, user, expressApp;

  before(async () => {
    expressApp = await app();
  });

  beforeEach(() => utils.resetTestDB());

  describe('WHEN calling /connected-accounts/github/oauthUrl', () => {
    beforeEach(async () => {
      user = await models.User.createUserWithCollective(utils.data('user1'));
    });

    it('returns 401 when not authenticated', done => {
      request(expressApp)
        .get('/connected-accounts/github/oauthUrl')
        .query({ api_key: application.api_key }) // eslint-disable-line camelcase
        .expect(401, done);
    });

    it('returns JSON with redirectUrl for an authenticated user', done => {
      const token = user.jwt({ scope: 'session' });

      request(expressApp)
        .get('/connected-accounts/github/oauthUrl')
        .query({ api_key: application.api_key }) // eslint-disable-line camelcase
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
        .end((err, res) => {
          expect(err).not.to.exist;
          expect(res.body.redirectUrl).to.be.a('string');

          const redirectUrl = new URL(res.body.redirectUrl);
          expect(redirectUrl.hostname).to.equal('github.com');
          expect(redirectUrl.pathname).to.equal('/login/oauth/authorize');
          expect(redirectUrl.searchParams.get('client_id')).to.equal(clientId);
          expect(redirectUrl.searchParams.get('redirect_uri')).to.be.a('string');
          expect(redirectUrl.searchParams.get('state')).to.be.a('string');

          // Security regression: access_token must NOT appear in the redirect_uri
          const callbackUrl = redirectUrl.searchParams.get('redirect_uri');
          expect(callbackUrl).to.not.include('access_token');

          done();
        });
    });

    it('stores a server-side state entry bound to the user', async () => {
      const token = user.jwt({ scope: 'session' });

      const res = await request(expressApp)
        .get('/connected-accounts/github/oauthUrl')
        .query({ api_key: application.api_key }) // eslint-disable-line camelcase
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const redirectUrl = new URL(res.body.redirectUrl);
      const stateKey = redirectUrl.searchParams.get('state');
      expect(stateKey).to.be.a('string').with.length.greaterThan(0);

      const storedState = await sessionCache.get(`oauth-github-state:${stateKey}`);
      expect(storedState).to.exist;
      expect(storedState.userId).to.equal(user.id);
    });

    it('stores context and CollectiveId in state', async () => {
      const token = user.jwt({ scope: 'session' });

      const res = await request(expressApp)
        .get('/connected-accounts/github/oauthUrl')
        .query({ api_key: application.api_key, context: 'createCollective', CollectiveId: 'my-org' }) // eslint-disable-line camelcase
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const redirectUrl = new URL(res.body.redirectUrl);
      const stateKey = redirectUrl.searchParams.get('state');
      const storedState = await sessionCache.get(`oauth-github-state:${stateKey}`);
      expect(storedState.context).to.equal('createCollective');
      expect(storedState.CollectiveId).to.equal('my-org');
    });
  });

  describe('WHEN calling /connected-accounts/github/callback', () => {
    beforeEach(async () => {
      user = await models.User.createUserWithCollective(utils.data('user1'));
    });

    it('returns 401 when no state param is provided', done => {
      request(expressApp)
        .get('/connected-accounts/github/callback')
        .query({ api_key: application.api_key, code: 'some-code' }) // eslint-disable-line camelcase
        .expect(401, done);
    });

    it('returns 401 when state does not match any cached entry', done => {
      request(expressApp)
        .get('/connected-accounts/github/callback')
        .query({ api_key: application.api_key, code: 'some-code', state: 'nonexistent-state-key' }) // eslint-disable-line camelcase
        .expect(401, done);
    });
  });

  describe('WHEN calling /connected-accounts/github/verify', () => {
    beforeEach(done => {
      req = request(expressApp).get('/connected-accounts/github/verify');
      done();
    });

    describe('WHEN calling without API key', () => {
      beforeEach(done => {
        const token = user.jwt({ scope: '' });
        req = req.set('Authorization', `Bearer ${token}`);
        done();
      });

      it('THEN returns 400', () => req.expect(400));
    });

    describe('WHEN providing API key but no token', () => {
      beforeEach(done => {
        req = req.send({ api_key: application.api_key }); // eslint-disable-line camelcase
        done();
      });

      it('THEN returns 401 Unauthorized', () => req.expect(401));
    });

    describe('WHEN providing API key and token but no username', () => {
      beforeEach(async () => {
        user = await models.User.createUserWithCollective(utils.data('user1'));
        req = req
          .set('Authorization', `Bearer ${user.jwt({ scope: 'connected-account' })}`)
          .send({ api_key: application.api_key }); // eslint-disable-line camelcase
      });

      it('THEN returns 400', () => req.expect(400));
    });

    describe('WHEN providing API key, token and scope', () => {
      beforeEach(async () => {
        user = await models.User.createUserWithCollective(utils.data('user1'));
        req = req
          .set(
            'Authorization',
            `Bearer ${user.jwt({
              scope: 'connected-account',
              username: 'asood123',
              connectedAccountId: 1,
            })}`,
          )
          .send({ api_key: application.api_key }); // eslint-disable-line camelcase
      });

      it('THEN returns 200 OK', done => {
        req.expect(200).end((err, res) => {
          expect(err).to.not.exist;
          expect(res.body.service).to.be.equal('github');
          expect(res.body.username).to.be.equal('asood123');
          expect(res.body.connectedAccountId).to.be.equal(1);
          done();
        });
      });
    });
  });
});
