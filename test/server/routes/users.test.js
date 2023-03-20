import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import moment from 'moment';
import nodemailer from 'nodemailer';
import { stub } from 'sinon';
import speakeasy from 'speakeasy';
import request from 'supertest';

import app from '../../../server/index';
import * as auth from '../../../server/lib/auth.js';
import models from '../../../server/models';
import { fakeUser } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

/**
 * Variables.
 */
const application = utils.data('application');
const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

/**
 * Tests.
 */
describe('server/routes/users', () => {
  let nm, expressApp;

  before(async () => {
    expressApp = await app();
  });

  beforeEach(() => utils.resetTestDB());

  // create a fake nodemailer transport
  beforeEach(() => {
    config.mailgun.user = 'xxxxx';
    config.mailgun.password = 'password';

    nm = nodemailer.createTransport({
      name: 'testsend',
      service: 'Mailgun',
      sendMail(data, callback) {
        callback();
      },
      logger: false,
    });
    stub(nodemailer, 'createTransport').callsFake(() => nm);
  });

  // stub the transport
  beforeEach(() => stub(nm, 'sendMail').callsFake((object, cb) => cb(null, object)));

  afterEach(() => nm.sendMail.restore());

  afterEach(() => {
    config.mailgun.user = '';
    config.mailgun.password = '';
    nodemailer.createTransport.restore();
  });

  describe('existence', () => {
    it('returns true', done => {
      models.User.create({ email: 'john@goodsmith.com' }).then(() => {
        request(expressApp)
          .get(`/users/exists?email=john@goodsmith.com&api_key=${application.api_key}`)
          .end((e, res) => {
            expect(res.body.exists).to.be.true;
            done();
          });
      });
    });

    it('returns false', done => {
      request(expressApp)
        .get(`/users/exists?email=john2@goodsmith.com&api_key=${application.api_key}`)
        .end((e, res) => {
          expect(res.body.exists).to.be.false;
          done();
        });
    });
  });

  /**
   * Receive a valid token & return a brand new token
   */
  describe('#exchangeLoginToken', () => {
    const updateTokenUrl = `/users/exchange-login-token?api_key=${application.api_key}`;

    it('should fail if no token is provided', async () => {
      const response = await request(expressApp).post(updateTokenUrl);
      expect(response.statusCode).to.equal(401);
    });

    it('should fail if expired token is provided', async () => {
      // Given a user and an authentication token
      const user = await fakeUser({ email: 'test@mctesterson.com' });
      const expiredToken = user.jwt({ scope: 'login' }, -1);

      // When the endpoint is hit with an expired token
      const response = await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${expiredToken}`);

      // Then the API rejects the request
      expect(response.statusCode).to.equal(401);
    });

    it("should fail if user's collective is marked as deleted", async () => {
      const user = await fakeUser({ email: 'test@mctesterson.com' });
      await user.collective.destroy(); // mark collective as deleted
      const currentToken = user.jwt({ scope: 'login' });
      const response = await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${currentToken}`);
      expect(response.statusCode).to.equal(401);
    });

    it('should validate received token', async () => {
      // Given a user and an authentication token
      const user = await fakeUser({ email: 'test@mctesterson.com' });
      const currentToken = user.jwt({ scope: 'login' });

      // When the endpoint is hit with a valid token
      const response = await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${currentToken}`);

      // Then it responds with success
      expect(response.statusCode).to.equal(200);

      // And then the response also contains a valid token
      const parsedToken = auth.verifyJwt(response.body.token);
      expect(parsedToken).to.be.exist;

      // And then the token should have a long expiration
      expect(moment(parsedToken.exp).diff(parsedToken.iat)).to.equal(auth.TOKEN_EXPIRATION_SESSION);
    });

    it('should respond with 2FA token if the user has 2FA enabled on account', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      const user = await fakeUser({ email: 'mopsa@mopsa.mopsa', twoFactorAuthToken: encryptedToken });
      const currentToken = user.jwt({ scope: 'login' });

      // When the endpoint is hit with a valid token
      const response = await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${currentToken}`);

      // Then it responds with success
      expect(response.statusCode).to.equal(200);

      // And then the response also contains a 2FA token
      const parsedToken = auth.verifyJwt(response.body.token);
      expect(parsedToken.scope).to.equal('twofactorauth');
    });

    it('should mark the user as confirmed', async () => {
      const user = await fakeUser({ confirmedAt: null });
      const currentToken = user.jwt({ scope: 'login' });
      await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${currentToken}`);

      await user.reload();
      expect(user.confirmedAt).to.exist;
      const userCollective = await user.getCollective();
      expect(userCollective.data.isGuest).to.be.false;
    });
  });

  describe('#refreshToken', () => {
    const updateTokenUrl = `/users/refresh-token?api_key=${application.api_key}`;

    it('should fail if no token is provided', async () => {
      const response = await request(expressApp).post(updateTokenUrl);
      expect(response.statusCode).to.equal(401);
    });

    it('should fail if expired token is provided', async () => {
      // Given a user and an authentication token
      const user = await fakeUser({ email: 'test@mctesterson.com' });
      const expiredToken = user.jwt({ scope: 'session' }, -1);

      // When the endpoint is hit with an expired token
      const response = await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${expiredToken}`);

      // Then the API rejects the request
      expect(response.statusCode).to.equal(401);
    });

    it("should fail if user's collective is marked as deleted", async () => {
      const user = await fakeUser({ email: 'test@mctesterson.com' });
      await user.collective.destroy(); // mark collective as deleted
      const currentToken = user.jwt({ scope: 'session' });
      const response = await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${currentToken}`);
      expect(response.statusCode).to.equal(401);
    });

    it('should validate received token', async () => {
      // Given a user and an authentication token
      const user = await fakeUser({ email: 'test@mctesterson.com' });
      const currentToken = user.jwt({ scope: 'session' });

      // When the endpoint is hit with a valid token
      const response = await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${currentToken}`);

      // Then it responds with success
      expect(response.statusCode).to.equal(200);

      // And then the response also contains a valid token
      const parsedToken = auth.verifyJwt(response.body.token);
      expect(parsedToken).to.be.exist;

      // And then the token should have a long expiration
      expect(moment(parsedToken.exp).diff(parsedToken.iat)).to.equal(auth.TOKEN_EXPIRATION_SESSION);
    });
  });

  /**
   * Receive a valid 2FA token & return a brand new token
   */
  describe('#twoFactorAuth', () => {
    const twoFactorAuthUrl = `/users/two-factor-auth?api_key=${application.api_key}`;

    it('should fail if no token is provided', async () => {
      const response = await request(expressApp).post(twoFactorAuthUrl);
      expect(response.statusCode).to.equal(401);
    });

    it('should fail if token with wrong scope is provided', async () => {
      // Given a user and an authentication token
      const user = await fakeUser({ email: 'test@mctesterson.com' });
      const badToken = user.jwt({ scope: 'nottwofactorauth' });

      // When the endpoint is hit with a token of the wrong scope
      const response = await request(expressApp).post(twoFactorAuthUrl).set('Authorization', `Bearer ${badToken}`);

      // Then the API rejects the request
      expect(response.statusCode).to.equal(401);
    });

    it('should reject 2FA if invalid TOTP code is received', async () => {
      // Given a user and an authentication token and a TOTP
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      const user = await fakeUser({ email: 'mopsa@mopsa.mopsa', twoFactorAuthToken: encryptedToken });
      const currentToken = user.jwt({ scope: 'twofactorauth' });
      const twoFactorAuthenticatorCode = '123456';

      // When the endpoint is hit with an invalid TOTP code
      const response = await request(expressApp)
        .post(twoFactorAuthUrl)
        .send({ twoFactorAuthenticatorCode })
        .set('Authorization', `Bearer ${currentToken}`);

      // Then it responds with errors
      expect(response.statusCode).to.equal(401);
      expect(response.body.error).to.exist;
      expect(response.body.error.message).to.match(/Two-factor authentication code failed. Please try again/);
    });

    it('should validate 2FA if correct TOTP code is received', async () => {
      // Given a user and an authentication token and a TOTP
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      const user = await fakeUser({ email: 'mopsa@mopsa.mopsa', twoFactorAuthToken: encryptedToken });
      const currentToken = user.jwt({ scope: 'twofactorauth' });
      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });

      // When the endpoint is hit with a valid TOTP code
      const response = await request(expressApp)
        .post(twoFactorAuthUrl)
        .send({ twoFactorAuthenticatorCode })
        .set('Authorization', `Bearer ${currentToken}`);

      // Then it responds with success
      expect(response.statusCode).to.equal(200);

      // And then the response also contains a valid token
      const parsedToken = auth.verifyJwt(response.body.token);
      expect(parsedToken).to.be.exist;

      // And then the token should have a long expiration
      expect(moment(parsedToken.exp).diff(parsedToken.iat)).to.equal(auth.TOKEN_EXPIRATION_SESSION);
    });
  });
});
