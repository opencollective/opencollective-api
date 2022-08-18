import {
  AuthorizationCode,
  Client,
  InvalidClientError,
  InvalidGrantError,
  InvalidTokenError,
  Token,
} from '@node-oauth/oauth2-server';
import { expect } from 'chai';
import config from 'config';
import moment from 'moment';
import { stub } from 'sinon';

import { activities } from '../../../../server/constants';
import OAuthModel, {
  dbApplicationToClient,
  dbOAuthAuthorizationCodeToAuthorizationCode,
} from '../../../../server/lib/oauth/model';
import models from '../../../../server/models';
import {
  fakeApplication,
  fakeOAuthAuthorizationCode,
  fakeUser,
  fakeUserToken,
  randStr,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

/**
 * Partially covers the OAuth model methods. For more comprehensive tests,
 * see the integration tests in `test/server/routes/oauth.test.ts`.
 */
describe('server/lib/oauth/model', () => {
  let configStub;

  before(async () => {
    await resetTestDB();
  });

  afterEach(() => {
    if (configStub) {
      configStub.restore();
      configStub = null;
    }
  });

  // -- Access token --

  describe('generateAccessToken', () => {
    it('generates a user token with a test prefix in test env', async () => {
      const token = await OAuthModel.generateAccessToken(null, null, null);
      expect(token).to.match(/^test_oauth_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });

    it('generates a user token with a non-test prefix in prod env', async () => {
      configStub = stub(config, 'env').get(() => 'production');
      const token = await OAuthModel.generateAccessToken(null, null, null);
      expect(token).to.match(/^oauth_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });
  });

  describe('getAccessToken', () => {
    it('returns a user token', async () => {
      const userToken = await fakeUserToken();
      const token = <Token>await OAuthModel.getAccessToken(userToken.accessToken);
      expect(token.id).to.eq(userToken.id);
      expect(token.user).to.not.be.null;
      expect(token.user.id).to.eq(userToken.user.id);
      expect(token.client).to.not.be.null;
      expect(token.client.id).to.eq(userToken.client.id);
    });

    it('throws if the token does not exist', async () => {
      await expect(OAuthModel.getAccessToken('not-a-token')).to.be.rejectedWith(InvalidTokenError);
    });
  });

  // -- Refresh token --

  describe('generateRefreshToken', () => {
    it('generates a refresh token with a test prefix in test env', async () => {
      const token = await OAuthModel.generateRefreshToken(null, null, null);
      expect(token).to.match(/^test_oauth_refresh_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });

    it('generates a refresh token with a non-test prefix in prod env', async () => {
      configStub = stub(config, 'env').get(() => 'production');
      const token = await OAuthModel.generateRefreshToken(null, null, null);
      expect(token).to.match(/^oauth_refresh_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });
  });

  describe('getRefreshToken', () => {
    it('returns a refresh token', async () => {
      const userToken = await fakeUserToken();
      const token = <Token>await OAuthModel.getRefreshToken(userToken.refreshToken);
      expect(token.id).to.eq(userToken.id);
      expect(token.user).to.not.be.null;
      expect(token.user.id).to.eq(userToken.user.id);
      expect(token.client).to.not.be.null;
      expect(token.client.id).to.eq(userToken.client.id);
    });

    it('throws if the token does not exist', async () => {
      await expect(OAuthModel.getRefreshToken('not-a-token')).to.be.rejectedWith(InvalidTokenError);
    });
  });

  describe('getClient', () => {
    it('returns the client from the application', async () => {
      const application = await fakeApplication();
      const client = <Client>await OAuthModel.getClient(application.clientId, application.clientSecret);
      expect(client).to.exist;
      expect(client.id).to.eq(application.clientId);
      expect(client.redirectUris).to.deep.eq([application.callbackUrl]);
    });

    it('throws if the client does not exist', async () => {
      await expect(OAuthModel.getClient('not-a-client', 'not-a-secret')).to.be.rejectedWith(InvalidClientError);
    });
  });

  describe('saveToken', () => {
    it('saves the token in DB', async () => {
      const application = await fakeApplication();
      const user = await fakeUser();
      const client = dbApplicationToClient(application);
      const token = <Token>await OAuthModel.saveToken(
        {
          accessToken: randStr(),
          accessTokenExpiresAt: moment().add(1, 'month').toDate(),
          refreshToken: randStr(),
          refreshTokenExpiresAt: moment().add(1, 'month').toDate(),
          client,
          user,
        },
        client,
        user,
      );

      expect(token).to.exist;

      const tokenFromDb = await models.UserToken.findOne({ where: { accessToken: token.accessToken } });
      expect(tokenFromDb).to.exist;
      expect(tokenFromDb.accessToken).to.eq(token.accessToken);
      expect(tokenFromDb.accessTokenExpiresAt.toISOString()).to.eq(token.accessTokenExpiresAt.toISOString());
      expect(tokenFromDb.refreshToken).to.eq(token.refreshToken);
      expect(tokenFromDb.refreshTokenExpiresAt.toISOString()).to.eq(token.refreshTokenExpiresAt.toISOString());
      expect(tokenFromDb.ApplicationId).to.eq(application.id);
      expect(tokenFromDb.UserId).to.eq(user.id);
    });
  });

  // -- Authorization code --

  describe('getAuthorizationCode', () => {
    it('returns an authorization code stored in DB', async () => {
      const authorizationInDb = await fakeOAuthAuthorizationCode();
      const authorizationCode = <AuthorizationCode>await OAuthModel.getAuthorizationCode(authorizationInDb.code);
      expect(authorizationCode).to.exist;
      expect(authorizationCode.authorizationCode).to.eq(authorizationInDb.code);
      expect(authorizationCode.user).to.not.be.null;
      expect(authorizationCode.user.id).to.eq(authorizationInDb.user.id);
      expect(authorizationCode.client).to.not.be.null;
      expect(authorizationCode.client.id).to.eq(authorizationInDb.application.clientId);
      expect(authorizationCode.redirectUri).to.eq(authorizationInDb.redirectUri);
    });

    it('throws if the code does not exist', async () => {
      await expect(OAuthModel.getAuthorizationCode('not-a-valid-code')).to.be.rejectedWith(InvalidGrantError);
    });
  });

  describe('saveAuthorizationCode', () => {
    it('creates the DB entry', async () => {
      const application = await fakeApplication();
      const client = dbApplicationToClient(application);
      const code = {
        authorizationCode: randStr(),
        expiresAt: new Date(),
        redirectUri: 'https://test.com',
        scope: ['email'],
      };

      await OAuthModel.saveAuthorizationCode(code, client, application.createdByUser);
      const authorizationFromDb = await models.OAuthAuthorizationCode.findOne({
        where: { code: code.authorizationCode },
      });

      expect(authorizationFromDb).to.exist;
      expect(authorizationFromDb.code).to.eq(code.authorizationCode);
      expect(authorizationFromDb.expiresAt.toISOString()).to.eq(code.expiresAt.toISOString());
      expect(authorizationFromDb.redirectUri).to.eq(code.redirectUri);

      const activity = await models.Activity.findOne({
        where: { UserId: application.createdByUser.id },
      });

      expect(activity).to.exist;
      expect(activity.type).to.eq(activities.OAUTH_APPLICATION_AUTHORIZED);
      expect(activity.data.application.id).to.eq(application.id);
      expect(activity.data.application.name).to.eq(application.name);
      expect(activity.data.application.description).to.eq(application.description);
      expect(activity.data.scope).deep.to.eq(['email']);
    });
  });

  describe('revokeAuthorizationCode', () => {
    it('marks the DB entry as deleted', async () => {
      const authorization = await fakeOAuthAuthorizationCode();
      const authorizationCode = dbOAuthAuthorizationCodeToAuthorizationCode(authorization);
      const hasRevoked = await OAuthModel.revokeAuthorizationCode(authorizationCode);
      await authorization.reload({ paranoid: false });
      expect(hasRevoked).to.be.true;
      expect(authorization.deletedAt).to.not.be.null;
    });

    it('returns false when nothing is deleted', async () => {
      const hasRevoked = await OAuthModel.revokeAuthorizationCode({
        authorizationCode: 'not-a-valid-code',
        expiresAt: undefined,
        redirectUri: '',
        client: undefined,
        user: undefined,
      });

      expect(hasRevoked).to.be.false;
    });
  });
});
