import { expect } from 'chai';
import config from 'config';
import { AuthorizationCode, Client, InvalidTokenError, Token } from 'oauth2-server';
import { stub } from 'sinon';

import OAuthModel, {
  dbApplicationToClient,
  dbOAuthAuthorizationCodeToAuthorizationCode,
} from '../../../../server/lib/oauth/model';
import models from '../../../../server/models';
import { fakeApplication, fakeOAuthAuthorizationCode, fakeUserToken, randStr } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

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

    // TODO responsibility? ('throws if the token is expired', async () => {});
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

    // TODO responsibility? ('throws if the token is expired', async () => {});
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
      await expect(OAuthModel.getClient('not-a-client', 'not-a-secret')).to.be.rejectedWith(InvalidTokenError);
    });
  });

  // describe('saveToken', () => {});

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
      await expect(OAuthModel.getAuthorizationCode('not-a-valid-code')).to.be.rejectedWith(InvalidTokenError);
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
      };

      await OAuthModel.saveAuthorizationCode(code, client, application.createdByUser);
      const authorizationFromDb = await models.OAuthAuthorizationCode.findOne({
        where: { code: code.authorizationCode },
      });

      expect(authorizationFromDb).to.exist;
      expect(authorizationFromDb.code).to.eq(code.authorizationCode);
      expect(authorizationFromDb.expiresAt.toISOString()).to.eq(code.expiresAt.toISOString());
      expect(authorizationFromDb.redirectUri).to.eq(code.redirectUri);
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
