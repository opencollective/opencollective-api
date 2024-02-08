import { fail } from 'assert';

import { expect } from 'chai';
import { createSandbox, stub } from 'sinon';

import { activities } from '../../../../server/constants';
import { sessionCache } from '../../../../server/lib/cache';
import twoFactorAuthLib from '../../../../server/lib/two-factor-authentication';
import { TwoFactorAuthenticationHeader } from '../../../../server/lib/two-factor-authentication/lib';
import totpProvider from '../../../../server/lib/two-factor-authentication/totp';
import models from '../../../../server/models';
import { fakePersonalToken, fakeUser, fakeUserToken } from '../../../test-helpers/fake-data';
import { waitForCondition } from '../../../utils';

describe('lib/two-factor-authentication', () => {
  describe('validateToken', () => {
    let sandbox;
    beforeEach(() => {
      sandbox = createSandbox();
    });

    afterEach(() => sandbox.restore());

    it('fails if auth type is not supported', async () => {
      const user = await fakeUser();
      const token = {
        type: 'fake-type',
      };

      await expect(twoFactorAuthLib.validateToken(user, token)).to.be.eventually.rejectedWith(
        Error,
        'Unsupported 2FA type fake-type',
      );
    });

    it('it calls provider', async () => {
      const validateTokenStub = sandbox.stub(totpProvider, 'validateToken');

      const user = await fakeUser();
      const token = {
        type: 'totp',
      };

      await expect(twoFactorAuthLib.validateToken(user, token)).to.be.eventually.fulfilled;
      expect(validateTokenStub).to.have.been.calledOnce;
      expect(validateTokenStub).to.have.been.calledWith(user, token);
    });
  });

  describe('getTwoFactorAuthTokenFromRequest', () => {
    it('returns null token if not present', async () => {
      const req = {
        get: stub().withArgs(TwoFactorAuthenticationHeader).returns(null),
      };

      expect(twoFactorAuthLib.getTwoFactorAuthTokenFromRequest(req)).to.be.null;
    });

    it('throws an error if value is malformed', async () => {
      const req = {
        get: stub(),
      };

      req.get.withArgs(TwoFactorAuthenticationHeader).returns('totp');
      expect(() => twoFactorAuthLib.getTwoFactorAuthTokenFromRequest(req)).to.throw('Malformed 2FA token header');

      req.get.withArgs(TwoFactorAuthenticationHeader).returns('totp ');
      expect(() => twoFactorAuthLib.getTwoFactorAuthTokenFromRequest(req)).to.throw('Malformed 2FA token header');
    });

    it('parses value correctly', async () => {
      const req = {
        get: stub(),
      };

      req.get.withArgs(TwoFactorAuthenticationHeader).returns('totp 12345');
      expect(twoFactorAuthLib.getTwoFactorAuthTokenFromRequest(req)).to.eql({
        type: 'totp',
        code: '12345',
      });

      req.get.withArgs(TwoFactorAuthenticationHeader).returns('webauthn iuyiuyi76876878bhsdad');
      expect(twoFactorAuthLib.getTwoFactorAuthTokenFromRequest(req)).to.eql({
        type: 'webauthn',
        code: 'iuyiuyi76876878bhsdad',
      });
    });
  });

  describe('userHasTwoFactorAuthEnabled', () => {
    it('return true if user has 2fa enabled', async () => {
      const user = await fakeUser({
        twoFactorAuthToken: '12345',
      });

      await expect(twoFactorAuthLib.userHasTwoFactorAuthEnabled(user)).to.eventually.equal(true);
    });

    it('return false if user has 2fa disabled', async () => {
      const user = await fakeUser();

      await expect(twoFactorAuthLib.userHasTwoFactorAuthEnabled(user)).to.eventually.equal(false);
    });
  });

  describe('validateRequest', () => {
    let sandbox;
    beforeEach(() => {
      sandbox = createSandbox();
    });

    afterEach(() => sandbox.restore());

    it('throws error if req does not have remoteUser', async () => {
      const req = {};

      await expect(twoFactorAuthLib.validateRequest(req)).to.eventually.rejectedWith(
        Error,
        'You need to be authenticated to perform this action',
      );
    });

    it('throws error if user does not have 2fa and 2fa is required', async () => {
      const req = {
        remoteUser: await fakeUser(),
      };

      try {
        await twoFactorAuthLib.validateRequest(req, { requireTwoFactorAuthEnabled: true });
        fail('expected validateRequest to throw exception');
      } catch (e) {
        expect(e.extensions).to.eql({ code: '2FA_REQUIRED' });
      }
    });

    it('succeeds if there is no token and 2fa is not required', async () => {
      const req = {
        remoteUser: await fakeUser(),
      };

      await expect(twoFactorAuthLib.validateRequest(req)).to.eventually.be.fulfilled;
    });

    it('fails if there is no token and 2fa token is always required', async () => {
      const req = {
        remoteUser: await fakeUser({ twoFactorAuthToken: '12345' }),
        get: stub().withArgs(TwoFactorAuthenticationHeader).returns('totp 1234'),
        isGraphQL: true,
        body: {
          operationName: 'Test',
          query: 'query Test { hello }',
        },
      };

      const totpValidateStub = sandbox.stub(totpProvider, 'validateToken');
      totpValidateStub.resolves();

      await expect(twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })).to.eventually.be.fulfilled;

      req.get.withArgs(TwoFactorAuthenticationHeader).returns(null);

      try {
        await twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true });
        fail('expected validateRequest to throw exception');
      } catch (e) {
        expect(e.extensions).to.eql({
          code: '2FA_REQUIRED',
          supportedMethods: ['totp', 'recovery_code'],
          authenticationOptions: {},
        });

        // The activity is created asynchronously, so we need to wait for it to be created
        let activity;
        await waitForCondition(async () => {
          activity = await models.Activity.findOne({
            where: { type: activities.TWO_FACTOR_CODE_REQUESTED, UserId: req.remoteUser.id },
          });
          return Boolean(activity);
        });

        expect(activity).to.exist;
        expect(activity.CollectiveId).to.equal(req.remoteUser.CollectiveId);
        expect(activity.FromCollectiveId).to.equal(req.remoteUser.CollectiveId);
        expect(activity.data).to.deep.include({
          context: 'GraphQL: Test',
          alwaysAskForToken: true,
        });
      }
    });

    it('fails if the token is invalid', async () => {
      const req = {
        remoteUser: await fakeUser({ twoFactorAuthToken: '12345' }),
        get: stub().withArgs(TwoFactorAuthenticationHeader).returns('totp 12345'),
      };

      try {
        await twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true });
        fail('expected validateRequest to throw exception');
      } catch (e) {
        expect(e.extensions).to.eql({ code: 'INVALID_2FA_CODE' });
      }
    });

    it('uses session to validate token', async () => {
      const req = {
        remoteUser: await fakeUser({ twoFactorAuthToken: '12345' }),
        get: stub().withArgs(TwoFactorAuthenticationHeader).returns('totp 12345'),
      };

      const totpValidateStub = sandbox.stub(totpProvider, 'validateToken');
      totpValidateStub.resolves();

      await expect(twoFactorAuthLib.validateRequest(req, { sessionKey: 'valid-session' })).to.eventually.be.fulfilled;

      req.get.withArgs(TwoFactorAuthenticationHeader).returns(null);
      await expect(twoFactorAuthLib.validateRequest(req, { sessionKey: 'valid-session' })).to.eventually.be.fulfilled;

      await expect(twoFactorAuthLib.validateRequest(req, { sessionKey: () => 'valid-session' })).to.eventually.be
        .fulfilled;

      try {
        await twoFactorAuthLib.validateRequest(req, { sessionKey: 'valid-session', alwaysAskForToken: true });
        fail('expected validateRequest to throw exception');
      } catch (e) {
        expect(e.extensions).to.eql({
          code: '2FA_REQUIRED',
          supportedMethods: ['totp', 'recovery_code'],
          authenticationOptions: {},
        });

        // The activity is created asynchronously, so we need to wait for it to be created
        let activity;
        await waitForCondition(async () => {
          activity = await models.Activity.findOne({
            where: { type: activities.TWO_FACTOR_CODE_REQUESTED, UserId: req.remoteUser.id },
          });
          return Boolean(activity);
        });

        expect(activity).to.exist;
        expect(activity.CollectiveId).to.equal(req.remoteUser.CollectiveId);
        expect(activity.FromCollectiveId).to.equal(req.remoteUser.CollectiveId);
        expect(activity.data).to.deep.include({
          context: 'default',
          alwaysAskForToken: true,
        });
      }

      try {
        await twoFactorAuthLib.validateRequest(req, { sessionKey: 'new-session' });
        fail('expected validateRequest to throw exception');
      } catch (e) {
        expect(e.extensions).to.eql({
          code: '2FA_REQUIRED',
          supportedMethods: ['totp', 'recovery_code'],
          authenticationOptions: {},
        });
      }
    });

    it('succeeds if token is valid', async () => {
      const req = {
        remoteUser: await fakeUser({ twoFactorAuthToken: '12345' }),
        get: stub().withArgs(TwoFactorAuthenticationHeader).returns('totp 12345'),
      };

      const totpValidateStub = sandbox.stub(totpProvider, 'validateToken');
      totpValidateStub.resolves();

      await expect(
        twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true, requireTwoFactorAuthEnabled: true }),
      ).to.eventually.be.fulfilled;
    });

    it('invalidates session after session duration', async () => {
      const req = {
        remoteUser: await fakeUser({ twoFactorAuthToken: '12345' }),
        get: stub().withArgs(TwoFactorAuthenticationHeader).returns('totp 12345'),
      };

      const totpValidateStub = sandbox.stub(totpProvider, 'validateToken');
      totpValidateStub.resolves();

      sandbox.stub(sessionCache, 'set').withArgs(`2fa:${req.remoteUser.id}:session`, {}, 2000).resolves(null);
      const cacheGet = sandbox.stub(sessionCache, 'get').withArgs(`2fa:${req.remoteUser.id}:session`).resolves(null);

      await twoFactorAuthLib.validateRequest(req, { sessionDuration: 2000, sessionKey: 'session' });
      cacheGet.withArgs(`2fa:${req.remoteUser.id}:session`).resolves({});

      req.get.withArgs(TwoFactorAuthenticationHeader).returns(null);
      await expect(twoFactorAuthLib.validateRequest(req, { sessionDuration: 2000, sessionKey: () => 'session' })).to
        .eventually.be.fulfilled;

      cacheGet.withArgs(`2fa:${req.remoteUser.id}:session`).resolves(null);
      try {
        await twoFactorAuthLib.validateRequest(req, { sessionDuration: 2000, sessionKey: 'session' });
        fail('expected validateRequest to throw exception');
      } catch (e) {
        expect(e.extensions).to.eql({
          code: '2FA_REQUIRED',
          supportedMethods: ['totp', 'recovery_code'],
          authenticationOptions: {},
        });
      }
    });

    it('does not check for any code if onlyAskOnLogin is true', async () => {
      const req = { remoteUser: await fakeUser({ twoFactorAuthToken: '12345' }) };
      await expect(twoFactorAuthLib.validateRequest(req, { onlyAskOnLogin: true, requireTwoFactorAuthEnabled: true }))
        .to.eventually.be.false;
    });

    it('still throws if onlyAskOnLogin is true and user has not 2FA enabled', async () => {
      const req = { remoteUser: await fakeUser() };
      await expect(
        twoFactorAuthLib.validateRequest(req, { onlyAskOnLogin: true, requireTwoFactorAuthEnabled: true }),
      ).to.eventually.be.rejected.and.deep.include({
        extensions: { code: '2FA_REQUIRED' },
      });
    });

    describe('Usage with personal tokens / OAuth (pre-authorized tokens)', () => {
      it('fails if using a personal token that has not been pre-authorized', async () => {
        const user = await fakeUser({ twoFactorAuthToken: '12345' });
        const personalToken = await fakePersonalToken({ user }); // Pre-authorize should be false by default
        const req = { remoteUser: user, personalToken };

        await expect(twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })).to.eventually.be.rejectedWith(
          'This personal token is not pre-authorized for 2FA',
        );
      });

      it('fails if using an OAuth token that has not been pre-authorized', async () => {
        const user = await fakeUser({ twoFactorAuthToken: '12345' });
        const userToken = await fakeUserToken({ user }); // Pre-authorize should be false by default
        const req = { remoteUser: user, userToken };

        await expect(twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })).to.eventually.be.rejectedWith(
          'This OAuth token is not pre-authorized for 2FA',
        );
      });

      it('works if using a personal token that has been pre-authorized', async () => {
        const user = await fakeUser({ twoFactorAuthToken: '12345' });
        const personalToken = await fakePersonalToken({ user, preAuthorize2FA: true }); // Pre-authorize should be false by default
        const req = { remoteUser: user, personalToken };

        await expect(twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })).to.eventually.be.fulfilled;
      });

      it('works if using an OAuth token that has been pre-authorized', async () => {
        const user = await fakeUser({ twoFactorAuthToken: '12345' });
        const userToken = await fakeUserToken({ user, preAuthorize2FA: true }); // Pre-authorize should be false by default
        const req = { remoteUser: user, userToken };

        await expect(twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })).to.eventually.be.fulfilled;
      });
    });
  });
});
