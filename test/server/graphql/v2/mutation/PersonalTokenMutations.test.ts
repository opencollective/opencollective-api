import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import gqlV2 from 'fake-tag';
import { times } from 'lodash-es';
import moment from 'moment';
import speakeasy from 'speakeasy';

import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib.js';
import { fakePersonalToken, fakeUser } from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2, resetTestDB } from '../../../../utils.js';

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

const CREATE_PERSONAL_TOKEN_MUTATION = gqlV2/* GraphQL */ `
  mutation CreatePersonalToken($personalToken: PersonalTokenCreateInput!) {
    createPersonalToken(personalToken: $personalToken) {
      id
      name
      scope
      token
      expiresAt
    }
  }
`;

const UPDATE_PERSONAL_TOKEN_MUTATION = gqlV2/* GraphQL */ `
  mutation UpdatePersonalToken($personalToken: PersonalTokenUpdateInput!) {
    updatePersonalToken(personalToken: $personalToken) {
      id
      name
      scope
      token
      expiresAt
    }
  }
`;

const DELETE_PERSONAL_TOKEN_MUTATION = gqlV2/* GraphQL */ `
  mutation DeletePersonalToken($personalToken: PersonalTokenReferenceInput!) {
    deletePersonalToken(personalToken: $personalToken) {
      id
    }
  }
`;

const VALID_TOKEN_PARAMS = {
  name: 'Test Personal Token',
  scope: ['expenses', 'host'],
  expiresAt: '2021-01-01',
};

describe('server/graphql/v2/mutation/PersonalTokenMutations', () => {
  before(resetTestDB);

  describe('createPersonalTokenMutation', () => {
    it('must be logged in', async () => {
      const result = await graphqlQueryV2(CREATE_PERSONAL_TOKEN_MUTATION, { personalToken: VALID_TOKEN_PARAMS });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });
    it('has a limitation on the number of tokens that can be created', async () => {
      const user = await fakeUser();
      // Create 15 applications (the limit)
      await Promise.all(
        times(config.limits.maxNumberOfAppsPerUser, () =>
          fakePersonalToken({ UserId: user.id, CollectiveId: user.CollectiveId }),
        ),
      );
      // Another one won't be allowed!
      const result = await graphqlQueryV2(CREATE_PERSONAL_TOKEN_MUTATION, { personalToken: VALID_TOKEN_PARAMS }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You have reached the maximum number of personal token for this user');
    });
    it('creates a personal token', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(CREATE_PERSONAL_TOKEN_MUTATION, { personalToken: VALID_TOKEN_PARAMS }, user);
      const personalToken = result.data.createPersonalToken;
      expect(result.errors).to.not.exist;
      expect(personalToken.name).to.equal(VALID_TOKEN_PARAMS.name);
      expect(personalToken.scope).to.deep.equal(VALID_TOKEN_PARAMS.scope);
      expect(moment(personalToken.expiresAt).format('YYYY-MM-DD')).to.equal(VALID_TOKEN_PARAMS.expiresAt);
      expect(personalToken.token).to.have.lengthOf(40);
    });
    it('creates a personal token with 2FA enabled', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });
      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });
      const result = await graphqlQueryV2(
        CREATE_PERSONAL_TOKEN_MUTATION,
        { personalToken: VALID_TOKEN_PARAMS },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `totp ${twoFactorAuthenticatorCode}`,
        },
      );
      expect(result.errors).to.not.exist;
      const personalToken = result.data.createPersonalToken;
      expect(personalToken.name).to.equal(VALID_TOKEN_PARAMS.name);
      expect(personalToken.scope).to.deep.equal(VALID_TOKEN_PARAMS.scope);
      expect(moment(personalToken.expiresAt).format('YYYY-MM-DD')).to.equal(VALID_TOKEN_PARAMS.expiresAt);
      expect(personalToken.token).to.have.lengthOf(40);
    });
    it('fails with invalid 2FA when 2FA enabled', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });
      const result = await graphqlQueryV2(
        CREATE_PERSONAL_TOKEN_MUTATION,
        { personalToken: VALID_TOKEN_PARAMS },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `totp 1234`,
        },
      );
      expect(result.errors[0].message).to.eq('Two-factor authentication code is invalid');
      expect(result.errors[0].extensions.code).to.eq('INVALID_2FA_CODE');
    });
    it('required 2FA when 2FA enabled', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });
      const result = await graphqlQueryV2(CREATE_PERSONAL_TOKEN_MUTATION, { personalToken: VALID_TOKEN_PARAMS }, user);
      expect(result.errors[0].message).to.eq('Two-factor authentication required');
      expect(result.errors[0].extensions.code).to.eq('2FA_REQUIRED');
    });
  });

  describe('updatePersonalTokenMutation', () => {
    it('must be logged in', async () => {
      const personalToken = await fakePersonalToken();
      const result = await graphqlQueryV2(UPDATE_PERSONAL_TOKEN_MUTATION, {
        personalToken: { legacyId: personalToken.id },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });
    it('must be an admin', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken();
      const result = await graphqlQueryV2(
        UPDATE_PERSONAL_TOKEN_MUTATION,
        { personalToken: { legacyId: personalToken.id } },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Authenticated user is not the token owner.');
    });
    it('token must exist', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(UPDATE_PERSONAL_TOKEN_MUTATION, { personalToken: { legacyId: -1 } }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Personal token Not Found');
    });
    it('updates a personal token', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({
        user,
      });
      const result = await graphqlQueryV2(
        UPDATE_PERSONAL_TOKEN_MUTATION,
        {
          personalToken: {
            legacyId: personalToken.id,
            ...VALID_TOKEN_PARAMS,
          },
        },
        user,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const updatedPersonalToken = result.data.updatePersonalToken;
      expect(updatedPersonalToken.name).to.equal(VALID_TOKEN_PARAMS.name);
      expect(updatedPersonalToken.scope).to.deep.equal(VALID_TOKEN_PARAMS.scope);
      expect(moment(updatedPersonalToken.expiresAt).format('YYYY-MM-DD')).to.equal(VALID_TOKEN_PARAMS.expiresAt);
    });
  });

  describe('deletePersonalTokenMutation', () => {
    it('must be logged in', async () => {
      const personalToken = await fakePersonalToken();
      const result = await graphqlQueryV2(DELETE_PERSONAL_TOKEN_MUTATION, {
        personalToken: { legacyId: personalToken.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('must be an admin', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken();
      const result = await graphqlQueryV2(
        DELETE_PERSONAL_TOKEN_MUTATION,
        { personalToken: { legacyId: personalToken.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Authenticated user is not the personal token owner.');
    });

    it('token must exist', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(DELETE_PERSONAL_TOKEN_MUTATION, { personalToken: { legacyId: -1 } }, user);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Personal token Not Found');
    });

    it('deletes a personal token', async () => {
      const user = await fakeUser();
      const personalToken = await fakePersonalToken({
        user,
      });
      const result = await graphqlQueryV2(
        DELETE_PERSONAL_TOKEN_MUTATION,
        { personalToken: { legacyId: personalToken.id } },
        user,
      );

      expect(result.errors).to.not.exist;
    });
  });
});
