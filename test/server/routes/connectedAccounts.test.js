import { expect } from 'chai';
import config from 'config';
import request from 'supertest';

import app from '../../../server/index.js';
import models from '../../../server/models/index.js';
import * as utils from '../../utils.js';

const clientId = config.github.clientID;
const application = utils.data('application');

describe('server/routes/connectedAccounts', () => {
  let req, user, expressApp;

  before(async () => {
    expressApp = await app();
  });

  beforeEach(() => utils.resetTestDB());

  describe('WHEN calling /connected-accounts/github/oauthUrl', () => {
    beforeEach(done => {
      req = request(expressApp).get('/connected-accounts/github/oauthUrl');
      done();
    });

    describe('WHEN calling /connected-accounts/github with API key', () => {
      beforeEach(done => {
        req = request(expressApp).get('/connected-accounts/github/oauthUrl').send({ api_key: application.api_key }); // eslint-disable-line camelcase
        done();
      });

      it('THEN returns 302 with location', done => {
        req.expect(302).end((err, res) => {
          expect(err).not.to.exist;
          const baseUrl = 'https://github.com/login/oauth/authorize';
          const redirectUri = encodeURIComponent(`${config.host.website}/api/connected-accounts/github/callback`);
          const scope = encodeURIComponent('user:email,public_repo,read:org');
          const location = `^${baseUrl}\\?response_type=code&redirect_uri=${redirectUri}&scope=${scope}&client_id=${clientId}$`;
          expect(res.headers.location).to.match(new RegExp(location));
          done();
        });
      });
    });
  });

  describe('WHEN calling /connected-accounts/github/callback', () => {
    beforeEach(done => {
      req = request(expressApp).get('/connected-accounts/github/callback');
      done();
    });

    describe('WHEN calling with invalid API key', () => {
      beforeEach(done => {
        req = req.send({ api_key: 'bla' }); // eslint-disable-line camelcase
        done();
      });

      it('THEN returns 401', () => req.expect(401));
    });

    describe('WHEN calling with valid API key', () => {
      beforeEach(done => {
        req = req.send({ api_key: application.api_key }); // eslint-disable-line camelcase
        done();
      });

      it('THEN returns 302 with location', done => {
        req.expect(302).end((err, res) => {
          expect(err).not.to.exist;
          expect(res.headers.location).to.be.equal(
            `https://github.com/login/oauth/authorize?response_type=code&redirect_uri=${encodeURIComponent(
              `${config.host.website}/api/connected-accounts/github/callback`,
            )}&client_id=${clientId}`,
          );
          done();
        });
      });
    });
  });

  describe('WHEN calling /connected-accounts/github/verify', () => {
    // Create user.
    beforeEach(async () => {
      user = await models.User.createUserWithCollective(utils.data('user1'));
    });

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
      beforeEach(done => {
        req = req
          .set('Authorization', `Bearer ${user.jwt({ scope: 'connected-account' })}`)
          .send({ api_key: application.api_key }); // eslint-disable-line camelcase
        done();
      });

      it('THEN returns 400', () => req.expect(400));
    });

    describe('WHEN providing API key, token and scope', () => {
      beforeEach(done => {
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
        done();
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
