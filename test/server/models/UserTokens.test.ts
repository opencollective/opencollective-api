import { expect } from 'chai';
import config from 'config';
import { stub, useFakeTimers } from 'sinon';

import UserToken from '../../../server/models/UserToken';
import { fakeApplication, fakeUser } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('server/models/UserToken', () => {
  let configStub, clock;

  before(async () => {
    await utils.resetTestDB();
  });

  afterEach(() => {
    if (configStub) {
      configStub.restore();
      configStub = null;
    }
    if (clock) {
      clock.restore();
      clock = null;
    }
  });

  describe('generate', () => {
    it('generates a user token with a test prefix in test env', async () => {
      const user = await fakeUser();
      const application = await fakeApplication({ user });
      const userToken = await UserToken.generateOAuth(user.id, application.id);
      expect(userToken.token).to.match(/^test_oauth_[A-Za-z0-9 _.,!"'/$]+/);
      expect(userToken.token.length).to.eq(64);
    });

    it('generates a user token with a non-test prefix in prod env', async () => {
      configStub = stub(config, 'env').get(() => 'production');
      const user = await fakeUser();
      const application = await fakeApplication({ user });
      const userToken = await UserToken.generateOAuth(user.id, application.id);
      expect(userToken.token).to.match(/^oauth_[A-Za-z0-9 _.,!"'/$]+/);
      expect(userToken.token.length).to.eq(64);
    });

    it('sets all properties for token', async () => {
      clock = useFakeTimers(new Date(2022, 0, 1));
      const user = await fakeUser();
      const application = await fakeApplication({ user });
      const customData = { userId: '42.42.42.42' };
      const userToken = await UserToken.generateOAuth(user.id, application.id, customData);
      expect(userToken.token.length).to.eq(64);
      expect(userToken.expiresAt).to.not.be.null;
      expect(userToken.expiresAt.toISOString()).to.eq('2022-03-02T00:00:00.000Z'); // 60 days
      expect(userToken.refreshToken.length).to.eq(64);
      expect(userToken.refreshTokenExpiresAt.toISOString()).to.eq('2022-12-27T00:00:00.000Z'); // 360 days
      expect(userToken.ApplicationId).to.eq(application.id);
      expect(userToken.UserId).to.eq(user.id);
      expect(userToken.data).to.deep.eq(customData);
      expect(userToken.createdAt.toISOString()).to.eq('2022-01-01T00:00:00.000Z');
      expect(userToken.updatedAt.toISOString()).to.eq('2022-01-01T00:00:00.000Z');
      expect(userToken.deletedAt).to.be.null;
    });
  });
});
