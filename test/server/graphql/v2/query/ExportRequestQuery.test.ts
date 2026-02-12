import { expect } from 'chai';
import gql from 'fake-tag';

import { ExportRequestStatus, ExportRequestTypes } from '../../../../../server/models/ExportRequest';
import { fakeCollective, fakeExportRequest, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const exportRequestQuery = gql`
  query ExportRequest($exportRequest: ExportRequestReferenceInput!) {
    exportRequest(exportRequest: $exportRequest) {
      id
      legacyId
      name
      type
      status
      parameters
      account {
        legacyId
      }
      progress
      error
      createdAt
      updatedAt
    }
  }
`;

describe('server/graphql/v2/query/ExportRequestQuery', () => {
  describe('authentication and authorization', () => {
    it('requires user to be logged in', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });
      const exportRequest = await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
      });

      const result = await graphqlQueryV2(
        exportRequestQuery,
        {
          exportRequest: { legacyId: exportRequest.id },
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
        exportRequestQuery,
        {
          exportRequest: { legacyId: exportRequest.id },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('You do not have permission');
    });

    it('allows admin of the account to view export request', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });
      const exportRequest = await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        name: 'Test Export',
        type: ExportRequestTypes.TRANSACTIONS,
        status: ExportRequestStatus.COMPLETED,
      });

      const result = await graphqlQueryV2(
        exportRequestQuery,
        {
          exportRequest: { legacyId: exportRequest.id },
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.exportRequest.legacyId).to.eq(exportRequest.id);
      expect(result.data.exportRequest.name).to.eq('Test Export');
      expect(result.data.exportRequest.type).to.eq('TRANSACTIONS');
      expect(result.data.exportRequest.status).to.eq('COMPLETED');
    });
  });

  describe('reference input', () => {
    it('can fetch by legacyId', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });
      const exportRequest = await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        name: 'Legacy ID Test',
      });

      const result = await graphqlQueryV2(
        exportRequestQuery,
        {
          exportRequest: { legacyId: exportRequest.id },
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.exportRequest.legacyId).to.eq(exportRequest.id);
      expect(result.data.exportRequest.name).to.eq('Legacy ID Test');
    });

    it('returns null when export request does not exist and throwIfMissing is false', async () => {
      const adminUser = await fakeUser();

      const query = gql`
        query ExportRequest($exportRequest: ExportRequestReferenceInput!, $throwIfMissing: Boolean!) {
          exportRequest(exportRequest: $exportRequest, throwIfMissing: $throwIfMissing) {
            id
            legacyId
          }
        }
      `;

      const result = await graphqlQueryV2(
        query,
        {
          exportRequest: { legacyId: 999999 },
          throwIfMissing: false,
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.exportRequest).to.be.null;
    });
  });
});
