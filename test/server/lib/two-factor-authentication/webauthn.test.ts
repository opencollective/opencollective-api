import crypto from 'crypto';

import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import { expect } from 'chai';
import config from 'config';

import { TwoFactorMethod } from '../../../../server/lib/two-factor-authentication';
import {
  authenticationOptions,
  generateRegistrationOptions,
  validateToken,
} from '../../../../server/lib/two-factor-authentication/webauthn';
import { UserTwoFactorMethodWebAuthnData } from '../../../../server/models/UserTwoFactorMethod';
import { fakeUser, fakeUserTwoFactorMethod } from '../../../test-helpers/fake-data';

/**
 * Builds a WebAuthn ES256 (P-256) credential and a way to sign authentication assertions with it,
 * mimicking what a security key or platform authenticator does on the client.
 */
const generateES256Authenticator = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });

  // COSE_Key for an EC2 / P-256 public key, as stored by verifyRegistrationResponse
  const cosePublicKey = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, isoBase64URL.toBuffer(jwk.x)], // x
      [-3, isoBase64URL.toBuffer(jwk.y)], // y
    ]),
  );

  const credentialId = isoBase64URL.fromBuffer(crypto.randomBytes(16));

  const signAssertion = ({ challenge, counter }: { challenge: string; counter: number }) => {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge, origin: config.webauthn.expectedOrigins[0] }),
    );

    // authenticatorData = rpIdHash (32) || flags (1) || signCount (4)
    const authenticatorData = Buffer.alloc(37);
    crypto.createHash('sha256').update(config.webauthn.rpId).digest().copy(authenticatorData, 0);
    authenticatorData[32] = 0x01; // UP (user present)
    authenticatorData.writeUInt32BE(counter, 33);

    // Authenticators return ECDSA signatures DER-encoded (ASN.1 SEQUENCE { r, s }), which is what
    // @simplewebauthn/server has to parse back into raw r || s before verifying
    const signature = crypto.sign(
      'sha256',
      Buffer.concat([authenticatorData, crypto.createHash('sha256').update(clientDataJSON).digest()]),
      {
        key: privateKey,
        dsaEncoding: 'der',
      },
    );

    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
        signature: isoBase64URL.fromBuffer(signature),
      },
    };
  };

  return { credentialId, credentialPublicKey: Buffer.from(cosePublicKey).toString('base64url'), signAssertion };
};

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
        const user = await fakeUser();
        const token = {
          type: TwoFactorMethod.WEBAUTHN,
          code: Buffer.from(JSON.stringify({ id: 'non-existent-credential' })).toString('base64'),
        };

        await expect(validateToken(user, token, {})).to.be.rejectedWith('Two-factor authentication code is invalid');
      });

      // Regression test: @simplewebauthn/server parses ES256 signatures with @peculiar/asn1-schema. If the
      // dependency tree ends up with two copies of that package (one for AsnParser, one for the ECDSASigValue
      // schema), every security key / passkey check fails with "Cannot get schema for 'ECDSASigValue' target".
      it('verifies an ES256 assertion signed by a security key', async () => {
        const user = await fakeUser();
        const authenticator = generateES256Authenticator();
        const method = await fakeUserTwoFactorMethod({
          UserId: user.id,
          method: TwoFactorMethod.WEBAUTHN,
          name: 'Security Key',
          data: {
            aaguid: '00000000-0000-0000-0000-000000000000',
            credentialPublicKey: authenticator.credentialPublicKey,
            credentialId: authenticator.credentialId,
            counter: 0,
            credentialDeviceType: 'singleDevice',
            credentialType: 'public-key',
            fmt: 'none',
            attestationObject: 'test-attestation',
          },
        });

        const challenge = isoBase64URL.fromBuffer(crypto.randomBytes(32));
        const req = { jwtPayload: { scope: 'twofactorauth', authenticationOptions: { webauthn: { challenge } } } };
        const assertion = authenticator.signAssertion({ challenge, counter: 1 });
        const token = {
          type: TwoFactorMethod.WEBAUTHN,
          code: Buffer.from(JSON.stringify(assertion)).toString('base64'),
        };

        await validateToken(user, token, req);

        await method.reload();
        expect((method.data as UserTwoFactorMethodWebAuthnData).counter).to.equal(1);
      });

      it('rejects an ES256 assertion for a different challenge', async () => {
        const user = await fakeUser();
        const authenticator = generateES256Authenticator();
        await fakeUserTwoFactorMethod({
          UserId: user.id,
          method: TwoFactorMethod.WEBAUTHN,
          name: 'Security Key',
          data: {
            aaguid: '00000000-0000-0000-0000-000000000000',
            credentialPublicKey: authenticator.credentialPublicKey,
            credentialId: authenticator.credentialId,
            counter: 0,
            credentialDeviceType: 'singleDevice',
            credentialType: 'public-key',
            fmt: 'none',
            attestationObject: 'test-attestation',
          },
        });

        const challenge = isoBase64URL.fromBuffer(crypto.randomBytes(32));
        const req = { jwtPayload: { scope: 'twofactorauth', authenticationOptions: { webauthn: { challenge } } } };
        const assertion = authenticator.signAssertion({
          challenge: isoBase64URL.fromBuffer(crypto.randomBytes(32)),
          counter: 1,
        });
        const token = {
          type: TwoFactorMethod.WEBAUTHN,
          code: Buffer.from(JSON.stringify(assertion)).toString('base64'),
        };

        await expect(validateToken(user, token, req)).to.be.rejected;
      });
    });
  });
});
