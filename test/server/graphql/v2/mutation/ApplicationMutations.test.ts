import { expect } from 'chai';
import config from 'config';
import gqlV2 from 'fake-tag';
import { times } from 'lodash';

import models from '../../../../../server/models';
import { fakeApplication, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const CREATE_APPLICATION_MUTATION = gqlV2/* GraphQL */ `
  mutation CreateApplication($application: ApplicationCreateInput!) {
    createApplication(application: $application) {
      id
      legacyId
      name
      description
      type
      apiKey
      callbackUrl
      clientId
      clientSecret
    }
  }
`;

const UPDATE_APPLICATION_MUTATION = gqlV2/* GraphQL */ `
  mutation UpdateApplication($application: ApplicationUpdateInput!) {
    updateApplication(application: $application) {
      id
      legacyId
      name
      description
      type
      apiKey
      callbackUrl
      clientId
      clientSecret
    }
  }
`;

const DELETE_APPLICATION_MUTATION = gqlV2/* GraphQL */ `
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
  callbackUrl: 'https://example.com/callback',
};

const INVALID_CALLBACK_URLS = [
  '0.0.0.0',
  'localhost',
  'http://localhost',
  'https://opencollective.com',
  'https://0.0.0.0',
  'https://12.12.12.12',
];

describe('server/graphql/v2/mutation/ApplicationMutations', () => {
  before(resetTestDB);

  describe('createApplicationMutation', () => {
    it('must be logged in', async () => {
      const result = await graphqlQueryV2(CREATE_APPLICATION_MUTATION, { application: VALID_APPLICATION_PARAMS });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be authenticated to create an application.');
    });

    it('callback URL must be valid / non-internal', async () => {
      const user = await fakeUser();
      for (const callbackUrl of INVALID_CALLBACK_URLS) {
        const result = await graphqlQueryV2(
          CREATE_APPLICATION_MUTATION,
          { application: { ...VALID_APPLICATION_PARAMS, callbackUrl } },
          user,
        );

        expect(result.errors).to.exist;
        const formattedUrl = callbackUrl.replace(/^https?:\/\//, '');
        expect(result.errors[0].message).to.include(`Not a valid URL: ${formattedUrl}`);
      }
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
      expect(resultApp.callbackUrl).to.eq(VALID_APPLICATION_PARAMS.callbackUrl);
      expect(resultApp.clientId).to.have.length(32); // TODO: value length?
      expect(resultApp.clientSecret).to.have.length(32); // TODO: value length?

      // User/application is not provided by GraphQL, so we need to fetch it from the DB
      const appFromDB = await models.Application.findByPk(resultApp.legacyId);
      expect(appFromDB.CreatedByUserId).to.eq(user.id);
      expect(appFromDB.CollectiveId).to.eq(user.CollectiveId);
    });
  });

  describe('updateApplicationMutation', () => {
    it('must be logged in', async () => {
      const application = await fakeApplication();
      const result = await graphqlQueryV2(UPDATE_APPLICATION_MUTATION, {
        application: { legacyId: application.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be authenticated to update an application.');
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

    it('callback URL must be valid / non-internal', async () => {
      const application = await fakeApplication();
      const user = await application.getCreatedByUser();
      for (const callbackUrl of INVALID_CALLBACK_URLS) {
        const result = await graphqlQueryV2(
          UPDATE_APPLICATION_MUTATION,
          { application: { legacyId: application.id, callbackUrl } },
          user,
        );

        expect(result.errors).to.exist;
        const formattedUrl = callbackUrl.replace(/^https?:\/\//, '');
        expect(result.errors[0].message).to.include(`Not a valid URL: ${formattedUrl}`);
      }
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
      expect(resultApp.callbackUrl).to.eq(VALID_APPLICATION_PARAMS.callbackUrl);
    });
  });

  describe('deleteApplication', () => {
    it('must be logged in', async () => {
      const application = await fakeApplication();
      const result = await graphqlQueryV2(DELETE_APPLICATION_MUTATION, {
        application: { legacyId: application.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be authenticated to delete an application.');
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
