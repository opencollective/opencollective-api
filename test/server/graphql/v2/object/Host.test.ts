import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import models from '../../../../../server/models/index.js';
import { VirtualCardStatus } from '../../../../../server/models/VirtualCard.js';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeUploadedFile,
  fakeUser,
  fakeVirtualCard,
} from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2 } from '../../../../utils.js';

const hostQuery = gqlV2/* GraphQL */ `
  query Host($slug: String!, $accounts: [AccountReferenceInput]) {
    host(slug: $slug) {
      id
      hostedAccountAgreements(accounts: $accounts) {
        totalCount
        nodes {
          id
          title
          attachment {
            name
          }
        }
      }
    }
  }
`;

describe('server/graphql/v2/object/Host', () => {
  describe('hostedAccountAgreements', () => {
    it('should return agreements with its hosted accounts', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const uploadedFile = await fakeUploadedFile({ fileName: 'my agreement.pdf' });
      await models.Agreement.create({
        title: 'test title',
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        UploadedFileId: uploadedFile.id,
      });

      const result = await graphqlQueryV2(hostQuery, { slug: host.slug }, hostAdmin);
      expect(result.data.host.hostedAccountAgreements.totalCount).to.eql(1);
      expect(result.data.host.hostedAccountAgreements.nodes).to.have.length(1);
      expect(result.data.host.hostedAccountAgreements.nodes[0].title).to.eql('test title');
      expect(result.data.host.hostedAccountAgreements.nodes[0].attachment).to.eql({
        name: 'my agreement.pdf',
      });
    });

    it('should filter agreements by hosted account slug', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const secondAccount = await fakeCollective({ HostCollectiveId: host.id });
      const uploadedFile = await fakeUploadedFile({ fileName: 'my agreement.pdf' });
      await models.Agreement.create({
        title: 'test title',
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        UploadedFileId: uploadedFile.id,
      });

      await models.Agreement.create({
        title: 'second test title',
        CollectiveId: secondAccount.id,
        HostCollectiveId: host.id,
      });

      const result = await graphqlQueryV2(
        hostQuery,
        {
          slug: host.slug,
          accounts: [
            {
              slug: account.slug,
            },
          ],
        },
        hostAdmin,
      );
      expect(result.data.host.hostedAccountAgreements.totalCount).to.eql(1);
      expect(result.data.host.hostedAccountAgreements.nodes).to.have.length(1);
      expect(result.data.host.hostedAccountAgreements.nodes[0].title).to.eql('test title');
      expect(result.data.host.hostedAccountAgreements.nodes[0].attachment).to.eql({
        name: 'my agreement.pdf',
      });

      const otherResult = await graphqlQueryV2(
        hostQuery,
        {
          slug: host.slug,
          accounts: [
            {
              slug: secondAccount.slug,
            },
          ],
        },
        hostAdmin,
      );
      expect(otherResult.data.host.hostedAccountAgreements.totalCount).to.eql(1);
      expect(otherResult.data.host.hostedAccountAgreements.nodes).to.have.length(1);
      expect(otherResult.data.host.hostedAccountAgreements.nodes[0].title).to.eql('second test title');
    });

    it('should filter agreements by hosted account slug or id', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const secondAccount = await fakeCollective({ HostCollectiveId: host.id });
      const uploadedFile = await fakeUploadedFile({ fileName: 'my agreement.pdf' });
      await models.Agreement.create({
        title: 'test title',
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        UploadedFileId: uploadedFile.id,
      });

      await models.Agreement.create({
        title: 'second test title',
        CollectiveId: secondAccount.id,
        HostCollectiveId: host.id,
      });

      const result = await graphqlQueryV2(
        hostQuery,
        {
          slug: host.slug,
          accounts: [
            {
              slug: account.slug,
            },
            {
              legacyId: secondAccount.id,
            },
          ],
        },
        hostAdmin,
      );
      expect(result.data.host.hostedAccountAgreements.totalCount).to.eql(2);
      expect(result.data.host.hostedAccountAgreements.nodes).to.have.length(2);
    });
  });

  describe('hostedVirtualCards', () => {
    const query = gqlV2/* GraphQL */ `
      query Host(
        $slug: String!
        $status: [VirtualCardStatus]
        $collectiveAccountIds: [AccountReferenceInput]
        $withExpensesDateFrom: DateTime
        $withExpensesDateTo: DateTime
      ) {
        host(slug: $slug) {
          id
          hostedVirtualCards(
            orderBy: { direction: ASC }
            status: $status
            collectiveAccountIds: $collectiveAccountIds
            withExpensesDateFrom: $withExpensesDateFrom
            withExpensesDateTo: $withExpensesDateTo
          ) {
            totalCount
            nodes {
              id
              status
            }
          }
        }
      }
    `;

    it('returns all virtual cards', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const vc1 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.ACTIVE,
        },
      });

      const vc2 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.INACTIVE,
        },
      });

      const vc3 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.CANCELED,
        },
      });

      const result = await graphqlQueryV2(query, { slug: host.slug }, hostAdmin);
      expect(result.data.host.hostedVirtualCards.totalCount).to.eql(3);

      expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
        {
          id: vc1.id,
          status: 'ACTIVE',
        },
        {
          id: vc2.id,
          status: 'INACTIVE',
        },
        {
          id: vc3.id,
          status: 'CANCELED',
        },
      ]);
    });

    it('filter virtual cards by status', async () => {
      const hostAdmin = await fakeUser();
      const host = await fakeHost({ admin: hostAdmin });
      const account = await fakeCollective({ HostCollectiveId: host.id });
      const vc1 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.ACTIVE,
        },
      });

      await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.INACTIVE,
        },
      });

      const vc3 = await fakeVirtualCard({
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        data: {
          status: VirtualCardStatus.CANCELED,
        },
      });

      const result = await graphqlQueryV2(query, { slug: host.slug, status: ['ACTIVE', 'CANCELED'] }, hostAdmin);

      expect(result.data.host.hostedVirtualCards.totalCount).to.eql(2);

      expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
        {
          id: vc1.id,
          status: 'ACTIVE',
        },
        {
          id: vc3.id,
          status: 'CANCELED',
        },
      ]);
    });

    describe('filter virtual cards by expense date', async () => {
      let hostAdmin, host, vc1, vc2, vc3;
      before(async () => {
        hostAdmin = await fakeUser();
        host = await fakeHost({ admin: hostAdmin });
        const account = await fakeCollective({ HostCollectiveId: host.id });
        vc1 = await fakeVirtualCard({
          CollectiveId: account.id,
          HostCollectiveId: host.id,
          data: {
            status: VirtualCardStatus.ACTIVE,
          },
        });

        await fakeExpense({
          VirtualCardId: vc1.id,
          createdAt: new Date(2021, 6, 15),
        });

        vc2 = await fakeVirtualCard({
          CollectiveId: account.id,
          HostCollectiveId: host.id,
          data: {
            status: VirtualCardStatus.INACTIVE,
          },
        });

        await fakeExpense({
          VirtualCardId: vc2.id,
          createdAt: new Date(2022, 6, 15),
        });

        vc3 = await fakeVirtualCard({
          CollectiveId: account.id,
          HostCollectiveId: host.id,
          data: {
            status: VirtualCardStatus.CANCELED,
          },
        });

        await fakeExpense({
          VirtualCardId: vc3.id,
          createdAt: new Date(2023, 6, 15),
        });
      });

      it('filters from start date', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2021, 6, 15), withExpensesDateTo: null },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(3);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc1.id,
            status: 'ACTIVE',
          },
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
          {
            id: vc3.id,
            status: 'CANCELED',
          },
        ]);
      });

      it('filters one virtual card with start to end date', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2021, 6, 15), withExpensesDateTo: new Date(2022, 6, 14) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(1);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc1.id,
            status: 'ACTIVE',
          },
        ]);
      });

      it('filters first virtual cards', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2021, 6, 15), withExpensesDateTo: new Date(2022, 6, 15) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(2);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc1.id,
            status: 'ACTIVE',
          },
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
        ]);
      });

      it('filters with end date only', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: null, withExpensesDateTo: new Date(2022, 6, 15) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(2);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc1.id,
            status: 'ACTIVE',
          },
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
        ]);
      });

      it('filters last two virtual cards ', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2022, 6, 15), withExpensesDateTo: new Date(2023, 6, 15) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(2);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
          {
            id: vc3.id,
            status: 'CANCELED',
          },
        ]);
      });

      it('filters cards used on a specific date', async () => {
        const result = await graphqlQueryV2(
          query,
          { slug: host.slug, withExpensesDateFrom: new Date(2022, 6, 15), withExpensesDateTo: new Date(2022, 6, 15) },
          hostAdmin,
        );

        expect(result.data.host.hostedVirtualCards.totalCount).to.eql(1);
        expect(result.data.host.hostedVirtualCards.nodes).to.deep.eql([
          {
            id: vc2.id,
            status: 'INACTIVE',
          },
        ]);
      });
    });
  });
});
