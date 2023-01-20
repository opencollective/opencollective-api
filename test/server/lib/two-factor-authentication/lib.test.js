import { fail } from 'assert';

import { expect } from 'chai';
import { createSandbox, stub } from 'sinon';

import cache from '../../../../server/lib/cache';
import twoFactorAuthLib from '../../../../server/lib/two-factor-authentication';
import { TwoFactorAuthenticationHeader } from '../../../../server/lib/two-factor-authentication/lib';
import totpProvider from '../../../../server/lib/two-factor-authentication/totp';
import { fakeUser } from '../../../test-helpers/fake-data';

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

      expect(twoFactorAuthLib.userHasTwoFactorAuthEnabled(user)).to.be.true;
    });

    it('return false if user has 2fa disabled', async () => {
      const user = await fakeUser();

      expect(twoFactorAuthLib.userHasTwoFactorAuthEnabled(user)).to.be.false;
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
      };

      const totpValidateStub = sandbox.stub(totpProvider, 'validateToken');
      totpValidateStub.resolves();

      await expect(twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true })).to.eventually.be.fulfilled;

      req.get.withArgs(TwoFactorAuthenticationHeader).returns(null);

      try {
        await twoFactorAuthLib.validateRequest(req, { alwaysAskForToken: true });
        fail('expected validateRequest to throw exception');
      } catch (e) {
        expect(e.extensions).to.eql({ code: '2FA_REQUIRED', supportedMethods: ['totp'] });
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
        expect(e.extensions).to.eql({ code: '2FA_REQUIRED', supportedMethods: ['totp'] });
      }

      try {
        await twoFactorAuthLib.validateRequest(req, { sessionKey: 'new-session' });
        fail('expected validateRequest to throw exception');
      } catch (e) {
        expect(e.extensions).to.eql({ code: '2FA_REQUIRED', supportedMethods: ['totp'] });
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

      sandbox.stub(cache, 'set').withArgs(`2fa:${req.remoteUser.id}:session`, {}, 2000).resolves(null);
      const cacheGet = sandbox.stub(cache, 'get').withArgs(`2fa:${req.remoteUser.id}:session`).resolves(null);

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
        expect(e.extensions).to.eql({ code: '2FA_REQUIRED', supportedMethods: ['totp'] });
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
  });
});
