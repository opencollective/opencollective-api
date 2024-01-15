import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import gql from 'fake-tag';
import { times } from 'lodash';
import speakeasy from 'speakeasy';

import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import models from '../../../../../server/models';
import { fakeApplication, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

const CREATE_APPLICATION_MUTATION = gql`
  mutation CreateApplication($application: ApplicationCreateInput!) {
    createApplication(application: $application) {
      id
      legacyId
      name
      description
      type
      apiKey
      redirectUri
      clientId
      clientSecret
    }
  }
`;

const UPDATE_APPLICATION_MUTATION = gql`
  mutation UpdateApplication($application: ApplicationUpdateInput!) {
    updateApplication(application: $application) {
      id
      legacyId
      name
      description
      type
      apiKey
      redirectUri
      clientId
      clientSecret
    }
  }
`;

const DELETE_APPLICATION_MUTATION = gql`
  mutation DeleteApplication($application: ApplicationReferenceInput!) {
    deleteApplication(application: $application) {
      id
      legacyId
    }
  }
`;

const VALID_APPLICATION_PARAMS = {
  name: 'Test Application',
  description: 'Test Application description',
  redirectUri: 'https://example.com/callback',
};

describe('server/graphql/v2/mutation/ApplicationMutations', () => {
  before(resetTestDB);

  describe('createApplicationMutation', () => {
    it('must be logged in', async () => {
      const result = await graphqlQueryV2(CREATE_APPLICATION_MUTATION, { application: VALID_APPLICATION_PARAMS });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('has a limitation on the number of apps that can be created', async () => {
      const user = await fakeUser();

      // Create 15 applications (the limit)
      await Promise.all(
        times(config.limits.maxNumberOfAppsPerUser, () =>
          fakeApplication({ UserId: user.id, CollectiveId: user.CollectiveId }),
        ),
      );

      // Another one won't be allowed!
      const result = await graphqlQueryV2(CREATE_APPLICATION_MUTATION, { application: VALID_APPLICATION_PARAMS }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You have reached the maximum number of applications for this user');
    });

    it('creates an OAUTH application', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(CREATE_APPLICATION_MUTATION, { application: VALID_APPLICATION_PARAMS }, user);
      expect(result.errors).to.not.exist;
      const resultApp = result.data.createApplication;
      expect(resultApp.id).to.exist;
      expect(resultApp.type).to.eq('OAUTH');
      expect(resultApp.name).to.eq(VALID_APPLICATION_PARAMS.name);
      expect(resultApp.description).to.eq(VALID_APPLICATION_PARAMS.description);
      expect(resultApp.redirectUri).to.eq(VALID_APPLICATION_PARAMS.redirectUri);
      expect(resultApp.clientId).to.have.length(20);
      expect(resultApp.clientSecret).to.have.length(40);

      // User/application is not provided by GraphQL, so we need to fetch it from the DB
      const appFromDB = await models.Application.findByPk(resultApp.legacyId);
      expect(appFromDB.CreatedByUserId).to.eq(user.id);
      expect(appFromDB.CollectiveId).to.eq(user.CollectiveId);
    });

    it('creates an OAUTH application with 2FA enabled', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });

      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });
      const result = await graphqlQueryV2(
        CREATE_APPLICATION_MUTATION,
        { application: VALID_APPLICATION_PARAMS },
        user,
        null,
        {
          [TwoFactorAuthenticationHeader]: `totp ${twoFactorAuthenticatorCode}`,
        },
      );
      expect(result.errors).to.not.exist;
      const resultApp = result.data.createApplication;
      expect(resultApp.id).to.exist;
      expect(resultApp.type).to.eq('OAUTH');
      expect(resultApp.name).to.eq(VALID_APPLICATION_PARAMS.name);
      expect(resultApp.description).to.eq(VALID_APPLICATION_PARAMS.description);
      expect(resultApp.redirectUri).to.eq(VALID_APPLICATION_PARAMS.redirectUri);
      expect(resultApp.clientId).to.have.length(20);
      expect(resultApp.clientSecret).to.have.length(40);

      // User/application is not provided by GraphQL, so we need to fetch it from the DB
      const appFromDB = await models.Application.findByPk(resultApp.legacyId);
      expect(appFromDB.CreatedByUserId).to.eq(user.id);
      expect(appFromDB.CollectiveId).to.eq(user.CollectiveId);
    });

    it('invalid 2FA when 2FA enabled and invalid', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();

      const user = await fakeUser({ twoFactorAuthToken: encryptedToken });
      const result = await graphqlQueryV2(
        CREATE_APPLICATION_MUTATION,
        { application: VALID_APPLICATION_PARAMS },
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
      const result = await graphqlQueryV2(CREATE_APPLICATION_MUTATION, { application: VALID_APPLICATION_PARAMS }, user);
      expect(result.errors[0].message).to.eq('Two-factor authentication required');
      expect(result.errors[0].extensions.code).to.eq('2FA_REQUIRED');
    });
  });

  describe('updateApplicationMutation', () => {
    it('must be logged in', async () => {
      const application = await fakeApplication();
      const result = await graphqlQueryV2(UPDATE_APPLICATION_MUTATION, {
        application: { legacyId: application.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('must be an admin', async () => {
      const user = await fakeUser();
      const application = await fakeApplication();
      const result = await graphqlQueryV2(
        UPDATE_APPLICATION_MUTATION,
        { application: { legacyId: application.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Authenticated user is not the application owner.');
    });

    it('application must exist', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(UPDATE_APPLICATION_MUTATION, { application: { legacyId: -1 } }, user);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Application Not Found');
    });

    it('updates an OAUTH application', async () => {
      const application = await fakeApplication({ type: 'oAuth' });
      const user = await application.getCreatedByUser();
      const result = await graphqlQueryV2(
        UPDATE_APPLICATION_MUTATION,
        {
          application: {
            legacyId: application.id,
            ...VALID_APPLICATION_PARAMS,
          },
        },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultApp = result.data.updateApplication;
      expect(resultApp.name).to.eq(VALID_APPLICATION_PARAMS.name);
      expect(resultApp.description).to.eq(VALID_APPLICATION_PARAMS.description);
      expect(resultApp.redirectUri).to.eq(VALID_APPLICATION_PARAMS.redirectUri);
    });
  });

  describe('deleteApplication', () => {
    it('must be logged in', async () => {
      const application = await fakeApplication();
      const result = await graphqlQueryV2(DELETE_APPLICATION_MUTATION, {
        application: { legacyId: application.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('must be an admin', async () => {
      const user = await fakeUser();
      const application = await fakeApplication();
      const result = await graphqlQueryV2(
        DELETE_APPLICATION_MUTATION,
        { application: { legacyId: application.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Authenticated user is not the application owner.');
    });

    it('application must exist', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(DELETE_APPLICATION_MUTATION, { application: { legacyId: -1 } }, user);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Application Not Found');
    });

    it('deletes an application', async () => {
      const application = await fakeApplication();
      const user = await application.getCreatedByUser();
      const result = await graphqlQueryV2(
        DELETE_APPLICATION_MUTATION,
        { application: { legacyId: application.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultApp = result.data.deleteApplication;
      expect(resultApp.legacyId).to.eq(application.id);

      await application.reload({ paranoid: false });
      expect(application.deletedAt).to.exist;
    });
  });
});
