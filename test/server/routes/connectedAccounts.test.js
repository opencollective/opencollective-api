import { expect } from 'chai';
import config from 'config';
import request from 'supertest';

import app from '../../../server/index';
import * as utils from '../../utils';

const clientId = config.github.clientID;
const application = utils.data('application');

describe('server/routes/connectedAccounts', () => {
  let req, expressApp;

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
});
