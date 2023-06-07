import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import Agreement from '../../../../../server/models/Agreement';
import { fakeCollective, fakeHost, fakeUploadedFile, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

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
      await Agreement.create({
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
      await Agreement.create({
        title: 'test title',
        CollectiveId: account.id,
        HostCollectiveId: host.id,
        UploadedFileId: uploadedFile.id,
      });

      await Agreement.create({
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
  });
});
