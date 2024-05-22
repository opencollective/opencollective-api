import crypto from 'crypto';

import { AsnParser, OctetString } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import * as simplewebauthn from '@simplewebauthn/server';
// eslint-disable-next-line import/no-unresolved, n/no-missing-import
import { decodeAttestationObject } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialDescriptorFuture,
  RegistrationResponseJSON,
  // eslint-disable-next-line import/no-unresolved, n/no-missing-import
} from '@simplewebauthn/types';
import config from 'config';

import { ApolloError } from '../../graphql/errors';
import { idEncode, IDENTIFIER_TYPES } from '../../graphql/v2/identifiers';
import User from '../../models/User';
import UserTwoFactorMethod, { UserTwoFactorMethodWebAuthnData } from '../../models/UserTwoFactorMethod';
import { TOKEN_EXPIRATION_2FA } from '../auth';
import cache from '../cache';

import { getFidoMetadata, MetadataEntry } from './fido-metadata';
import { Token } from './lib';
import { TwoFactorMethod } from './two-factor-methods';

const WebAuthnTimeoutSeconds = TOKEN_EXPIRATION_2FA;
const SupportedPublicKeyAlgorithmIDs = [
  -7, // ES256
  -8, // EdDSA
  -257, // RS256
];

export async function validateToken(user: User, token: Token, req): Promise<void> {
  const authenticationResponse: AuthenticationResponseJSON = JSON.parse(
    Buffer.from(token.code, 'base64').toString('utf-8'),
  );

  const method = await UserTwoFactorMethod.findOne<UserTwoFactorMethod<TwoFactorMethod.WEBAUTHN>>({
    where: {
      UserId: user.id,
      method: TwoFactorMethod.WEBAUTHN,
      data: {
        credentialId: authenticationResponse.id,
      },
    },
  });

  if (!method) {
    throw new ApolloError('Two-factor authentication code is invalid', 'INVALID_2FA_CODE');
  }

  await verifyAuthenticationResponse(user, authenticationResponse, req);
}

export async function generateRegistrationOptions(user: User, req): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const collective = user.collective ?? (await user.getCollective());

  const methods = await UserTwoFactorMethod.findAll<UserTwoFactorMethod<TwoFactorMethod.WEBAUTHN>>({
    where: {
      UserId: user.id,
      method: TwoFactorMethod.WEBAUTHN,
    },
  });

  const excludeCredentials = methods.map(
    method =>
      <PublicKeyCredentialDescriptorFuture>{
        id: Buffer.from(method.data.credentialId, 'base64url'),
        type: 'public-key',
      },
  );

  const options = await simplewebauthn.generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpId,
    userID: idEncode(user.id, IDENTIFIER_TYPES.USER),
    userName: collective.slug,
    userDisplayName: collective.name,
    attestationType: 'direct',
    excludeCredentials,
    authenticatorSelection: {
      userVerification: 'discouraged',
      residentKey: 'discouraged',
      requireResidentKey: false,
    },
    timeout: WebAuthnTimeoutSeconds * 1000,
    supportedAlgorithmIDs: SupportedPublicKeyAlgorithmIDs,
  });

  await cache.set(
    `webauth-registration-challenge:${user.id}:${req.jwtPayload?.sessionId}`,
    options.challenge,
    WebAuthnTimeoutSeconds,
  );
  return options;
}

export async function verifyRegistrationResponse(
  user: User,
  req,
  response: RegistrationResponseJSON,
): Promise<simplewebauthn.VerifiedRegistrationResponse> {
  const expectedChallenge = await cache.get(`webauth-registration-challenge:${user.id}:${req.jwtPayload?.sessionId}`);
  const verifyResponse = await simplewebauthn.verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.webauthn.expectedOrigins,
    expectedRPID: config.webauthn.rpId,
    requireUserVerification: false,
    supportedAlgorithmIDs: SupportedPublicKeyAlgorithmIDs,
  });

  if (!verifyResponse.verified) {
    throw new Error('Invalid registration result.');
  }

  const metadata = await getAuthenticatorMetadata(verifyResponse);

  for (const report of metadata?.statusReports ?? []) {
    if (report.status === 'REVOKED') {
      throw new Error('Authenticator not supported.');
    }
  }

  return verifyResponse;
}

export async function authenticationOptions(user: User, req) {
  const methods = await UserTwoFactorMethod.findAll<UserTwoFactorMethod<TwoFactorMethod.WEBAUTHN>>({
    where: {
      UserId: user.id,
      method: TwoFactorMethod.WEBAUTHN,
    },
  });

  const allowCredentials = methods.map(
    method =>
      <PublicKeyCredentialDescriptorFuture>{
        id: Buffer.from(method.data.credentialId, 'base64url'),
        type: 'public-key',
      },
  );

  const options = await simplewebauthn.generateAuthenticationOptions({
    allowCredentials,
    rpID: config.webauthn.rpId,
    userVerification: 'discouraged',
    timeout: WebAuthnTimeoutSeconds * 1000,
  });

  if (req.jwtPayload) {
    await cache.set(
      `webauth-authentication-challenge:${user.id}:${req.jwtPayload?.sessionId}`,
      options.challenge,
      WebAuthnTimeoutSeconds,
    );
  }

  return options;
}

export async function verifyAuthenticationResponse(user: User, response: AuthenticationResponseJSON, req) {
  const method = await UserTwoFactorMethod.findOne<UserTwoFactorMethod<TwoFactorMethod.WEBAUTHN>>({
    where: {
      UserId: user.id,
      method: TwoFactorMethod.WEBAUTHN,
      data: {
        credentialId: response.id,
      },
    },
  });

  if (!method) {
    throw new ApolloError('Two-factor authentication code is invalid', 'INVALID_2FA_CODE');
  }

  let expectedChallenge;
  if (req.jwtPayload.scope === 'twofactorauth') {
    expectedChallenge = req.jwtPayload.authenticationOptions?.webauthn?.challenge;
  } else {
    expectedChallenge = await cache.get(`webauth-authentication-challenge:${user.id}:${req.jwtPayload.sessionId}`);
  }

  const verificationResponse = await simplewebauthn.verifyAuthenticationResponse({
    authenticator: {
      counter: method.data.counter,
      credentialID: Buffer.from(method.data.credentialId, 'base64url'),
      credentialPublicKey: Buffer.from(method.data.credentialPublicKey, 'base64url'),
    },
    expectedChallenge,
    expectedOrigin: config.webauthn.expectedOrigins,
    expectedRPID: config.webauthn.rpId,
    response,
    advancedFIDOConfig: {
      userVerification: 'discouraged',
    },
    requireUserVerification: false,
  });

  if (!verificationResponse.verified) {
    throw new ApolloError('Two-factor authentication code is invalid', 'INVALID_2FA_CODE');
  }

  await method.update({
    data: {
      ...method.data,
      counter: verificationResponse.authenticationInfo.newCounter,
    },
  });
}

/**
 * Attempts to get the authenticator metadata (model, manufactor, validity, icon, etc) from the registration response.
 *
 * This method will use the aaguid present on the registration information and if not present will attempt to parse the aaguid
 * from the certificate of the attestation object.
 *
 * @param registrationResponse
 * @returns a promise for the authenticator metadata or null if not metadata is found or the device aguid cannot be determined
 */
async function getAuthenticatorMetadata(
  registrationResponse: simplewebauthn.VerifiedRegistrationResponse,
): Promise<MetadataEntry | null> {
  // if a aaguid (authenticator model identifier) is present and its not the default zero value,
  // try to get the authenticator metadata from the fido database.
  if (
    registrationResponse.registrationInfo?.aaguid &&
    registrationResponse.registrationInfo?.aaguid !== '00000000-0000-0000-0000-000000000000'
  ) {
    return await getFidoMetadata(registrationResponse.registrationInfo.aaguid);
  }

  // if the aaguid is missing and we also dont have an attestation (certificate) from the
  // authenticator, we can't get metadata from it.
  if (!registrationResponse.registrationInfo?.attestationObject) {
    return null;
  }

  // Attempt to get the aaguid from the attestation x.509 certificate.
  // The fido aaguid can be present on the Extension OID 1.3.6.1.4.1.45724.1.1.4 (id-fido-gen-ce-aaguid)
  // https://www.w3.org/Submission/2015/SUBM-fido-key-attestation-20151120/
  const attestationObject = decodeAttestationObject(
    Buffer.from(registrationResponse.registrationInfo?.attestationObject),
  );
  const attestationStatement = attestationObject.get('attStmt');
  if (!attestationStatement) {
    return null;
  }

  const certs = attestationStatement.get('x5c');
  if (!certs || certs.length === 0) {
    return null;
  }

  const pemCert = new crypto.X509Certificate(certs[0]);
  const cert = AsnParser.parse(pemCert.raw, Certificate);
  // get extension 1.3.6.1.4.1.45724.1.1.4 (id-fido-gen-ce-aaguid)
  const extension = cert.tbsCertificate.extensions.find(ext => ext.extnID === '1.3.6.1.4.1.45724.1.1.4');
  if (!extension) {
    return null;
  }

  // convert the aaguid value from a binary format to a guid string
  const aaguidValue = AsnParser.parse(extension.extnValue.buffer, OctetString).buffer;

  const aauigHex = Buffer.from(aaguidValue).toString('hex');
  const aaguid = `${aauigHex.slice(0, 8)}-${aauigHex.slice(8, 12)}-${aauigHex.slice(12, 16)}-${aauigHex.slice(
    16,
    20,
  )}-${aauigHex.slice(20)}`;

  registrationResponse.registrationInfo.aaguid = aaguid;

  return await getFidoMetadata(aaguid);
}

export async function getWebauthDeviceData(
  registrationResponse: simplewebauthn.VerifiedRegistrationResponse,
): Promise<UserTwoFactorMethodWebAuthnData> {
  const metadata = await getAuthenticatorMetadata(registrationResponse);

  return {
    aaguid: registrationResponse.registrationInfo.aaguid,
    description: metadata?.metadataStatement?.description,
    icon: metadata?.metadataStatement?.icon,
    credentialPublicKey: Buffer.from(registrationResponse.registrationInfo.credentialPublicKey).toString('base64url'),
    credentialId: Buffer.from(registrationResponse.registrationInfo.credentialID).toString('base64url'),
    counter: registrationResponse.registrationInfo.counter,
    credentialDeviceType: registrationResponse.registrationInfo.credentialDeviceType,
    credentialType: registrationResponse.registrationInfo.credentialType,
    fmt: registrationResponse.registrationInfo.fmt,
    attestationObject: Buffer.from(registrationResponse.registrationInfo.attestationObject).toString('base64url'),
  };
}
