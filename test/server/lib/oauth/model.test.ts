import { expect } from 'chai';
import config from 'config';
import jwt from 'jsonwebtoken';
import { InvalidTokenError } from 'oauth2-server';
import { stub } from 'sinon';

import OAuthModel from '../../../../server/lib/oauth/model';
import { fakeApplication, fakeUserToken } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const model = new OAuthModel();

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

  describe('generateAccessToken', () => {
    it('generates a user token with a test prefix in test env', async () => {
      const token = await model.generateAccessToken(null, null, null);
      expect(token).to.match(/^test_oauth_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });

    it('generates a user token with a non-test prefix in prod env', async () => {
      configStub = stub(config, 'env').get(() => 'production');
      const token = await model.generateAccessToken(null, null, null);
      expect(token).to.match(/^oauth_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });
  });

  describe('generateRefreshToken', () => {
    it('generates a refresh token with a test prefix in test env', async () => {
      const token = await model.generateRefreshToken(null, null, null);
      expect(token).to.match(/^test_oauth_refresh_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });

    it('generates a refresh token with a non-test prefix in prod env', async () => {
      configStub = stub(config, 'env').get(() => 'production');
      const token = await model.generateRefreshToken(null, null, null);
      expect(token).to.match(/^oauth_refresh_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });
  });

  describe('getAccessToken', () => {
    it('returns a user token', async () => {
      const userToken = await fakeUserToken();
      const token = await model.getAccessToken(userToken.accessToken);
      expect(token.id).to.eq(userToken.id);
      expect(token.user).to.not.be.null;
      expect(token.user.id).to.eq(userToken.user.id);
      expect(token.client).to.not.be.null;
      expect(token.client.id).to.eq(userToken.client.id);
    });

    it('throws if the token does not exist', async () => {
      await expect(model.getAccessToken('not-a-token')).to.be.rejectedWith(InvalidTokenError);
    });

    // TODO responsibility? ('throws if the token is expired', async () => {});
  });

  describe('getRefreshToken', () => {
    it('returns a refresh token', async () => {
      const userToken = await fakeUserToken();
      const token = await model.getRefreshToken(userToken.refreshToken);
      expect(token.id).to.eq(userToken.id);
      expect(token.user).to.not.be.null;
      expect(token.user.id).to.eq(userToken.user.id);
      expect(token.client).to.not.be.null;
      expect(token.client.id).to.eq(userToken.client.id);
    });

    it('throws if the token does not exist', async () => {
      await expect(model.getRefreshToken('not-a-token')).to.be.rejectedWith(InvalidTokenError);
    });

    // TODO responsibility? ('throws if the token is expired', async () => {});
  });

  describe('getAuthorizationCode', () => {
    it('decodes the JWT', () => {
      const code = {
        authorizationCode: 'test',
        expiresAt: new Date(),
        redirectUri: 'https://test.com',
        scope: 'test',
      };

      const encodedAuthorizationCode = jwt.encode();
      const decoded = jwt.verify(encodedAuthorizationCode, config.keys.opencollective.jwtSecret);
      expect(decoded).to.deep.eq({
        ...code,
        // TODO: Add additional properties here
      });
    });

    it('throws if JWT is invalid', () => {});
  });

  describe('getClient', () => {});

  describe('getUser', () => {});

  describe('getUserFromClient', () => {});

  describe('saveToken', () => {});

  describe('saveAuthorizationCode', () => {
    it('creates the JWT', async () => {
      const application = await fakeApplication();
      const code = {
        authorizationCode: 'test',
        expiresAt: new Date(),
        redirectUri: 'https://test.com',
        scope: 'test',
      };

      const encodedAuthorizationCode = await model.saveAuthorizationCode(code, application, application.createdByUser);
      const decoded = jwt.verify(encodedAuthorizationCode, config.keys.opencollective.jwtSecret);
      expect(decoded).to.deep.eq({
        ...code,
        // TODO: Add additional properties here
      });
    });
  });

  // describe('validateScope', () => {});

  // describe('verifyScope', () => {});
});
