import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import moment from 'moment';
import { generateSecret, generateSync } from 'otplib';
import sinon from 'sinon';
import request from 'supertest';

import ActivityTypes from '../../../server/constants/activities';
import app from '../../../server/index';
import * as auth from '../../../server/lib/auth';
import emailLib, { getTemplateAttributes } from '../../../server/lib/email';
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
  let expressApp;

  before(async () => {
    expressApp = await app();
  });

  beforeEach(() => utils.resetTestDB());

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

    it('should updates user lastLoginAt if scope = login', async () => {
      // Given a user and an authentication token
      const user = await fakeUser({ email: 'test@mctesterson.com' });
      const currentToken = user.jwt({ scope: 'login' });

      // When the endpoint is hit with a valid token
      await request(expressApp).post(updateTokenUrl).set('Authorization', `Bearer ${currentToken}`);

      const reloadUser = await models.User.findByPk(user.id);
      expect(reloadUser.lastLoginAt).to.be.a('date');
    });

    it('should respond with 2FA token if the user has 2FA enabled on account', async () => {
      const secret = generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret, SECRET_KEY).toString();
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
      const secret = generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret, SECRET_KEY).toString();
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
      const secret = generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret, SECRET_KEY).toString();
      const user = await fakeUser({ email: 'mopsa@mopsa.mopsa', twoFactorAuthToken: encryptedToken });
      const currentToken = user.jwt({ scope: 'twofactorauth' });
      const twoFactorAuthenticatorCode = generateSync({ secret });

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

  describe('#newPasswordSigninEmail', () => {
    const signinUrl = `/users/signin?api_key=${application.api_key}`;
    const exchangeLoginTokenUrl = `/users/exchange-login-token?api_key=${application.api_key}`;
    const refreshTokenUrl = `/users/refresh-token?api_key=${application.api_key}`;
    let sandbox;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      sandbox.stub(emailLib, 'send').resolves();
    });

    afterEach(() => {
      sandbox.restore();
    });

    const passwordSignin = (email, password, ip, userAgent) =>
      request(expressApp)
        .post(signinUrl)
        .send({ user: { email, password } })
        .set('X-Forwarded-For', ip)
        .set('User-Agent', userAgent);

    const sentNewPasswordSigninEmails = () =>
      emailLib.send.getCalls().filter(call => call.args[0] === ActivityTypes.USER_NEW_PASSWORD_SIGNIN);

    const renderEmailFromSendCall = call => {
      const [template, recipient, data] = call.args;
      const { html } = emailLib.generateEmailFromTemplate(template, recipient, data);
      return getTemplateAttributes(html);
    };

    const setupUserWithInitialPasswordSignin = async email => {
      const user = await fakeUser({ email });
      await user.setPassword('testpassword123');
      await passwordSignin(user.email, 'testpassword123', '192.168.1.1', 'Mozilla/5.0 (Known Device)');
      emailLib.send.resetHistory();
      return user;
    };

    it('should NOT send email on first password login', async () => {
      const user = await fakeUser({ email: 'newuser@example.com' });
      await user.setPassword('testpassword123');

      const response = await passwordSignin(user.email, 'testpassword123', '192.168.1.1', 'Mozilla/5.0');

      expect(response.statusCode).to.equal(200);
      expect(response.body.token).to.exist;
      expect(sentNewPasswordSigninEmails()).to.have.lengthOf(0);
    });

    it('should NOT send email when signing in with magic link', async () => {
      const user = await setupUserWithInitialPasswordSignin('magiclink@example.com');
      await user.reload();
      const loginToken = user.jwt({ scope: 'login' });

      const exchangeResponse = await request(expressApp)
        .post(exchangeLoginTokenUrl)
        .set('Authorization', `Bearer ${loginToken}`)
        .set('X-Forwarded-For', '192.168.1.2')
        .set('User-Agent', 'Different User Agent');

      expect(exchangeResponse.statusCode).to.equal(200);
      expect(sentNewPasswordSigninEmails()).to.have.lengthOf(0);
    });

    it('should NOT send email when signing in with password from known location/device', async () => {
      const user = await setupUserWithInitialPasswordSignin('knowndevice@example.com');
      const knownIp = '192.168.1.1';
      const knownUserAgent = 'Mozilla/5.0 (Known Device)';

      const response = await passwordSignin(user.email, 'testpassword123', knownIp, knownUserAgent);

      expect(response.statusCode).to.equal(200);
      expect(response.body.token).to.exist;
      expect(sentNewPasswordSigninEmails()).to.have.lengthOf(0);
    });

    it('should send email when signing in with password from new location/device', async () => {
      const user = await setupUserWithInitialPasswordSignin('newdevice@example.com');
      await user.reload({ include: [{ model: models.Collective, as: 'collective' }] });
      const newIp = '192.168.1.2';
      const newUserAgent = 'Mozilla/5.0 (New Device)';

      const response = await passwordSignin(user.email, 'testpassword123', newIp, newUserAgent);

      expect(response.statusCode).to.equal(200);
      expect(response.body.token).to.exist;
      expect(sentNewPasswordSigninEmails()).to.have.lengthOf(1);

      const sendCall = sentNewPasswordSigninEmails()[0];
      expect(sendCall.args[0]).to.equal(ActivityTypes.USER_NEW_PASSWORD_SIGNIN);
      expect(sendCall.args[1]).to.equal(user.email);

      const emailData = sendCall.args[2];
      expect(emailData.clientIP).to.equal(newIp);
      expect(emailData.userAgent).to.equal(newUserAgent);
      expect(emailData.signInTime).to.exist;
      expect(emailData.collective.slug).to.equal(user.collective.slug);

      const { subject, body } = renderEmailFromSendCall(sendCall);
      expect(subject).to.equal('New sign-in to your Open Collective account');
      expect(body).to.include('New sign-in detected');
      expect(body).to.include('new sign-in to your Open Collective account using your password');
      expect(body).to.include(newIp);
      expect(body).to.include(newUserAgent);
      expect(body).to.include(`/${user.collective.slug}/admin/user-security`);
      expect(body).to.include('Review Security Settings');
      expect(body).to.include('support@opencollective.com');
    });

    it('should NOT send email when lastLoginAt update fails', async () => {
      const user = await setupUserWithInitialPasswordSignin('dbfail@example.com');
      await user.reload();
      sandbox.stub(user, 'update').rejects(new Error('Database error'));

      const req = {
        ip: '192.168.1.2',
        header: name => (name === 'user-agent' ? 'Mozilla/5.0 (New Device)' : undefined),
      };

      try {
        await user.generateSessionToken({
          req,
          createActivity: false,
          updateLastLoginAt: true,
          isPasswordLogin: true,
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e.message).to.equal('Database error');
      }

      expect(sentNewPasswordSigninEmails()).to.have.lengthOf(0);
    });

    it('should NOT send email when signing in with a dev token (like generate-jwt.ts)', async () => {
      const user = await setupUserWithInitialPasswordSignin('devtoken@example.com');
      const devToken = await user.generateSessionToken({ createActivity: false, updateLastLoginAt: false });

      const response = await request(expressApp)
        .post(refreshTokenUrl)
        .set('Authorization', `Bearer ${devToken}`)
        .set('X-Forwarded-For', '192.168.1.2')
        .set('User-Agent', 'Mozilla/5.0 (Dev Token Sign-in)');

      expect(response.statusCode).to.equal(200);
      expect(response.body.token).to.exist;
      expect(sentNewPasswordSigninEmails()).to.have.lengthOf(0);
    });
  });
});
