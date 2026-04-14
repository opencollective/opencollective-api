import { expect } from 'chai';

import { TwoFactorMethod } from '../../../../server/lib/two-factor-authentication';
import {
  authenticationOptions,
  generateRegistrationOptions,
} from '../../../../server/lib/two-factor-authentication/webauthn';
import { fakeUser, fakeUserTwoFactorMethod } from '../../../test-helpers/fake-data';

describe('lib/two-factor-authentication', () => {
  describe('webauthn', () => {
    describe('generateRegistrationOptions', () => {
      it('returns valid registration options for a user', async () => {
        const user = await fakeUser();
        const req = { jwtPayload: { sessionId: 'test-session' } };

        const options = await generateRegistrationOptions(user, req);

        expect(options).to.have.property('challenge').that.is.a('string');
        expect(options).to.have.property('rp').that.includes.keys('name', 'id');
        expect(options).to.have.property('user').that.includes.keys('id', 'name', 'displayName');
        expect(options).to.have.property('pubKeyCredParams').that.is.an('array');
        expect(options).to.have.property('timeout').that.is.a('number');
        expect(options).to.have.property('attestation', 'direct');
        expect(options).to.have.property('excludeCredentials').that.is.an('array').with.lengthOf(0);
      });

      it('excludes existing credentials from registration options', async () => {
        const user = await fakeUser();
        await fakeUserTwoFactorMethod({
          UserId: user.id,
          method: TwoFactorMethod.WEBAUTHN,
          name: 'Test Device',
          data: {
            aaguid: '00000000-0000-0000-0000-000000000000',
            credentialPublicKey: 'test-public-key',
            credentialId: 'existing-credential-id',
            counter: 0,
            credentialDeviceType: 'singleDevice',
            credentialType: 'public-key',
            fmt: 'none',
            attestationObject: 'test-attestation',
          },
        });

        const req = { jwtPayload: { sessionId: 'test-session' } };
        const options = await generateRegistrationOptions(user, req);

        expect(options.excludeCredentials).to.have.lengthOf(1);
        expect(options.excludeCredentials[0]).to.deep.equal({
          id: 'existing-credential-id',
          type: 'public-key',
        });
      });
    });

    describe('authenticationOptions', () => {
      it('returns empty allowCredentials when user has no webauthn methods', async () => {
        const user = await fakeUser();
        const req = { jwtPayload: { sessionId: 'test-session' } };

        const options = await authenticationOptions(user, req);

        expect(options).to.have.property('challenge').that.is.a('string');
        expect(options).to.have.property('allowCredentials').that.is.an('array').with.lengthOf(0);
        expect(options).to.have.property('timeout').that.is.a('number');
        expect(options).to.have.property('rpId').that.is.a('string');
      });

      it('returns allowCredentials when user has webauthn methods', async () => {
        const user = await fakeUser();
        await fakeUserTwoFactorMethod({
          UserId: user.id,
          method: TwoFactorMethod.WEBAUTHN,
          name: 'Test Device 1',
          data: {
            aaguid: '00000000-0000-0000-0000-000000000000',
            credentialPublicKey: 'test-public-key-1',
            credentialId: 'credential-id-1',
            counter: 0,
            credentialDeviceType: 'singleDevice',
            credentialType: 'public-key',
            fmt: 'none',
            attestationObject: 'test-attestation-1',
          },
        });
        await fakeUserTwoFactorMethod({
          UserId: user.id,
          method: TwoFactorMethod.WEBAUTHN,
          name: 'Test Device 2',
          data: {
            aaguid: '00000000-0000-0000-0000-000000000000',
            credentialPublicKey: 'test-public-key-2',
            credentialId: 'credential-id-2',
            counter: 5,
            credentialDeviceType: 'multiDevice',
            credentialType: 'public-key',
            fmt: 'packed',
            attestationObject: 'test-attestation-2',
          },
        });

        const req = { jwtPayload: { sessionId: 'test-session' } };
        const options = await authenticationOptions(user, req);

        expect(options.allowCredentials).to.have.lengthOf(2);
        expect(options.allowCredentials).to.deep.include({ id: 'credential-id-1', type: 'public-key' });
        expect(options.allowCredentials).to.deep.include({ id: 'credential-id-2', type: 'public-key' });
      });

      it('does not include deleted webauthn methods', async () => {
        const user = await fakeUser();
        const method = await fakeUserTwoFactorMethod({
          UserId: user.id,
          method: TwoFactorMethod.WEBAUTHN,
          name: 'Deleted Device',
          data: {
            aaguid: '00000000-0000-0000-0000-000000000000',
            credentialPublicKey: 'test-public-key',
            credentialId: 'deleted-credential-id',
            counter: 0,
            credentialDeviceType: 'singleDevice',
            credentialType: 'public-key',
            fmt: 'none',
            attestationObject: 'test-attestation',
          },
        });
        await method.destroy();

        const req = { jwtPayload: { sessionId: 'test-session' } };
        const options = await authenticationOptions(user, req);

        expect(options.allowCredentials).to.have.lengthOf(0);
      });
    });

    describe('validateToken', () => {
      it('fails if credential is not found', async () => {
        const { validateToken } = await import('../../../../server/lib/two-factor-authentication/webauthn');
        const user = await fakeUser();
        const token = {
          type: TwoFactorMethod.WEBAUTHN,
          code: Buffer.from(JSON.stringify({ id: 'non-existent-credential' })).toString('base64'),
        };

        await expect(validateToken(user, token, {})).to.be.rejectedWith('Two-factor authentication code is invalid');
      });
    });
  });
});
