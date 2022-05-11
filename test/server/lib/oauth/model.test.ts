import { expect } from 'chai';
import config from 'config';
import { stub } from 'sinon';

import OAuthModel from '../../../../server/lib/oauth/model';
import { fakeUserToken } from '../../../test-helpers/fake-data';

describe('server/lib/oauth/model', () => {
  let configStub;

  afterEach(() => {
    if (configStub) {
      configStub.restore();
      configStub = null;
    }
  });

  describe('generateAccessToken', () => {
    it('generates a user token with a test prefix in test env', async () => {
      const token = await OAuthModel.generateAccessToken();
      expect(token).to.match(/^test_oauth_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });

    it('generates a user token with a non-test prefix in prod env', async () => {
      configStub = stub(config, 'env').get(() => 'production');
      const token = await OAuthModel.generateAccessToken();
      expect(token).to.match(/^oauth_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });
  });

  describe('generateRefreshToken', () => {
    it('generates a user token with a test prefix in test env', async () => {
      const token = await OAuthModel.generateRefreshToken();
      expect(token).to.match(/^test_oauth_refresh_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });

    it('generates a user token with a non-test prefix in prod env', async () => {
      configStub = stub(config, 'env').get(() => 'production');
      const token = await OAuthModel.generateRefreshToken();
      expect(token).to.match(/^oauth_refresh_[A-Za-z0-9 _.,!"'/$]+/);
      expect(token.length).to.eq(64);
    });
  });

  describe('getAccessToken', () => {
    it('returns a user token', async () => {
      const userToken = await fakeUserToken();
      const token = await OAuthModel.getAccessToken(userToken.token);
      expect(token.id).to.eq(userToken.id);
    });
  });

  describe('getRefreshToken', () => {});

  describe('getAuthorizationCode', () => {});

  describe('getClient', () => {});

  describe('getUser', () => {});

  describe('getUserFromClient', () => {});

  describe('saveToken', () => {});

  describe('saveAuthorizationCode', () => {});

  describe('revokeToken', () => {});

  describe('revokeAuthorizationCode', () => {});

  describe('validateScope', () => {});

  describe('verifyScope', () => {});
});
