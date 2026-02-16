import { expect } from 'chai';
import gql from 'fake-tag';

import { ExportRequestStatus, ExportRequestTypes } from '../../../../../server/models/ExportRequest';
import { fakeCollective, fakeExportRequest, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const exportRequestsCollectionQuery = gql`
  query ExportRequests(
    $account: AccountReferenceInput!
    $type: ExportRequestType
    $status: ExportRequestStatus
    $limit: Int!
    $offset: Int!
  ) {
    exportRequests(account: $account, type: $type, status: $status, limit: $limit, offset: $offset) {
      offset
      limit
      totalCount
      nodes {
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
  }
`;

describe('server/graphql/v2/collection/ExportRequestsCollectionQuery', () => {
  describe('authentication and authorization', () => {
    it('requires user to be logged in', async () => {
      const collective = await fakeCollective();

      const result = await graphqlQueryV2(
        exportRequestsCollectionQuery,
        {
          account: { legacyId: collective.id },
          limit: 10,
          offset: 0,
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

      await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
      });

      const result = await graphqlQueryV2(
        exportRequestsCollectionQuery,
        {
          account: { legacyId: collective.id },
          limit: 10,
          offset: 0,
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('You do not have permission');
    });

    it('allows admin of the account to view export requests', async () => {
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
        exportRequestsCollectionQuery,
        {
          account: { legacyId: collective.id },
          limit: 10,
          offset: 0,
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.exportRequests.totalCount).to.eq(1);
      expect(result.data.exportRequests.nodes[0].legacyId).to.eq(exportRequest.id);
      expect(result.data.exportRequests.nodes[0].name).to.eq('Test Export');
      expect(result.data.exportRequests.nodes[0].type).to.eq('TRANSACTIONS');
      expect(result.data.exportRequests.nodes[0].status).to.eq('COMPLETED');
    });
  });

  describe('filtering', () => {
    it('filters export requests by type', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });

      const transactionsExport = await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        type: ExportRequestTypes.TRANSACTIONS,
      });

      await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        type: ExportRequestTypes.HOSTED_COLLECTIVES,
      });

      const result = await graphqlQueryV2(
        exportRequestsCollectionQuery,
        {
          account: { legacyId: collective.id },
          type: 'TRANSACTIONS',
          limit: 10,
          offset: 0,
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.exportRequests.totalCount).to.eq(1);
      expect(result.data.exportRequests.nodes[0].legacyId).to.eq(transactionsExport.id);
      expect(result.data.exportRequests.nodes[0].type).to.eq('TRANSACTIONS');
    });

    it('filters export requests by status', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser });

      const completedExport = await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        status: ExportRequestStatus.COMPLETED,
      });

      await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        status: ExportRequestStatus.ENQUEUED,
      });

      await fakeExportRequest({
        CollectiveId: collective.id,
        CreatedByUserId: adminUser.id,
        status: ExportRequestStatus.PROCESSING,
      });

      const result = await graphqlQueryV2(
        exportRequestsCollectionQuery,
        {
          account: { legacyId: collective.id },
          status: 'COMPLETED',
          limit: 10,
          offset: 0,
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.exportRequests.totalCount).to.eq(1);
      expect(result.data.exportRequests.nodes[0].legacyId).to.eq(completedExport.id);
      expect(result.data.exportRequests.nodes[0].status).to.eq('COMPLETED');
    });
  });
});
