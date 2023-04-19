import * as simplewebauthn from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialDescriptorFuture,
  RegistrationResponseJSON,
  // eslint-disable-next-line node/no-missing-import, node/no-unpublished-import
} from '@simplewebauthn/typescript-types';
import config from 'config';

import { ApolloError } from '../../graphql/errors';
import { idEncode, IDENTIFIER_TYPES } from '../../graphql/v2/identifiers';
import User from '../../models/User';
import UserTwoFactorMethod from '../../models/UserTwoFactorMethod';
import cache from '../cache';

import { Token } from './lib';
import { TwoFactorMethod } from './two-factor-methods';

const WebAuthnTimeoutSeconds = 120;
const SupportedPublicKeyAlgorithmIDs = [
  -7, // ES256
  -8, // EdDSA
  -257, // RS256
];

export default {
  async validateToken(user: User, token: Token, req): Promise<void> {
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
  },
  async authenticationOptions(user: User, req) {
    return generateAuthenticationOptions(user, req);
  },
};

export async function generateRegistrationOptions(user: User, req): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const collective = user?.collective || (await user.getCollective());

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

  const options = simplewebauthn.generateRegistrationOptions({
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
  return await simplewebauthn.verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.webauthn.expectedOrigins,
    expectedRPID: config.webauthn.rpId,
    requireUserVerification: false,
    supportedAlgorithmIDs: SupportedPublicKeyAlgorithmIDs,
  });
}

export async function generateAuthenticationOptions(user: User, req) {
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

  const options = simplewebauthn.generateAuthenticationOptions({
    allowCredentials,
    rpID: config.webauthn.rpId,
    userVerification: 'discouraged',
    timeout: WebAuthnTimeoutSeconds * 1000,
  });

  await cache.set(
    `webauth-authentication-challenge:${user.id}:${req.jwtPayload?.sessionId}`,
    options.challenge,
    WebAuthnTimeoutSeconds,
  );

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

  const expectedChallenge = await cache.get(`webauth-authentication-challenge:${user.id}:${req.jwtPayload?.sessionId}`);

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
