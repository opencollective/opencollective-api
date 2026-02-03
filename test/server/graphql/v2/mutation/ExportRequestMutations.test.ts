import { expect } from 'chai';
import gql from 'fake-tag';

import { ExportRequestStatus, ExportRequestTypes } from '../../../../../server/models/ExportRequest';
import { fakeCollective, fakeExportRequest, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const createExportRequestMutation = gql`
  mutation CreateExportRequest($exportRequest: ExportRequestCreateInput!) {
    createExportRequest(exportRequest: $exportRequest) {
      id
      legacyId
      name
      type
      status
      parameters
      account {
        legacyId
      }
      createdAt
    }
  }
`;

const editExportRequestMutation = gql`
  mutation EditExportRequest($exportRequest: ExportRequestReferenceInput!, $name: String) {
    editExportRequest(exportRequest: $exportRequest, name: $name) {
      id
      legacyId
      name
      type
      status
      account {
        legacyId
      }
    }
  }
`;

describe('server/graphql/v2/mutation/ExportRequestMutations', () => {
  describe('createExportRequest', () => {
    it('requires user to be logged in', async () => {
      const collective = await fakeCollective();

      const result = await graphqlQueryV2(
        createExportRequestMutation,
        {
          exportRequest: {
            account: { legacyId: collective.id },
            name: 'Test Export',
            type: 'TRANSACTIONS',
          },
        },
        null,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('You need to be logged in');
    });

    it('requires user to be admin of the account', async () => {
      const adminUser = await fakeUser();
      const randomUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });

      const result = await graphqlQueryV2(
        createExportRequestMutation,
        {
          exportRequest: {
            account: { legacyId: collective.id },
            name: 'Test Export',
            type: 'TRANSACTIONS',
          },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('You do not have permission');
    });

    it('creates an export request and returns parameters', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });

      const parameters = {
        dateFrom: '2024-01-01',
        dateTo: '2024-12-31',
        format: 'csv',
      };

      const result = await graphqlQueryV2(
        createExportRequestMutation,
        {
          exportRequest: {
            account: { legacyId: collective.id },
            name: 'Test Export',
            type: 'TRANSACTIONS',
            parameters,
          },
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.createExportRequest.id).to.exist;
      expect(result.data.createExportRequest.legacyId).to.be.a('number');
      expect(result.data.createExportRequest.name).to.eq('Test Export');
      expect(result.data.createExportRequest.type).to.eq(ExportRequestTypes.TRANSACTIONS);
      expect(result.data.createExportRequest.status).to.eq(ExportRequestStatus.ENQUEUED);
      expect(result.data.createExportRequest.parameters).to.deep.eq(parameters);
      expect(result.data.createExportRequest.account.legacyId).to.eq(collective.id);
      expect(result.data.createExportRequest.createdAt).to.exist;
    });

    it('creates an export request without parameters', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });

      const result = await graphqlQueryV2(
        createExportRequestMutation,
        {
          exportRequest: {
            account: { legacyId: collective.id },
            name: 'Simple Export',
            type: 'HOSTED_COLLECTIVES',
          },
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.createExportRequest.id).to.exist;
      expect(result.data.createExportRequest.name).to.eq('Simple Export');
      expect(result.data.createExportRequest.type).to.eq(ExportRequestTypes.HOSTED_COLLECTIVES);
      expect(result.data.createExportRequest.status).to.eq(ExportRequestStatus.ENQUEUED);
      expect(result.data.createExportRequest.parameters).to.deep.eq({});
    });
  });

  describe('editExportRequest', () => {
    it('requires user to be logged in', async () => {
      const exportRequest = await fakeExportRequest();

      const result = await graphqlQueryV2(
        editExportRequestMutation,
        {
          exportRequest: { legacyId: exportRequest.id },
          name: 'Updated Name',
        },
        null,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('You need to be logged in');
    });

    it('requires user to be admin of the account', async () => {
      const adminUser = await fakeUser();
      const randomUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });
      const exportRequest = await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
      });

      const result = await graphqlQueryV2(
        editExportRequestMutation,
        {
          exportRequest: { legacyId: exportRequest.id },
          name: 'Updated Name',
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('You do not have permission');
    });

    it('returns not found for non-existent export request', async () => {
      const adminUser = await fakeUser();

      const result = await graphqlQueryV2(
        editExportRequestMutation,
        {
          exportRequest: { legacyId: -1 },
          name: 'Updated Name',
        },
        adminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('ExportRequest Not Found');
    });

    it('updates the name of an export request', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });
      const exportRequest = await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        name: 'Original Name',
        type: ExportRequestTypes.TRANSACTIONS,
      });

      const result = await graphqlQueryV2(
        editExportRequestMutation,
        {
          exportRequest: { legacyId: exportRequest.id },
          name: 'Updated Name',
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editExportRequest.legacyId).to.eq(exportRequest.id);
      expect(result.data.editExportRequest.name).to.eq('Updated Name');
      expect(result.data.editExportRequest.type).to.eq(ExportRequestTypes.TRANSACTIONS);
      expect(result.data.editExportRequest.account.legacyId).to.eq(collective.id);
    });

    it('does not change anything when no fields are provided', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });
      const exportRequest = await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        name: 'Original Name',
      });

      const result = await graphqlQueryV2(
        editExportRequestMutation,
        {
          exportRequest: { legacyId: exportRequest.id },
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editExportRequest.legacyId).to.eq(exportRequest.id);
      expect(result.data.editExportRequest.name).to.eq('Original Name');
    });
  });
});
