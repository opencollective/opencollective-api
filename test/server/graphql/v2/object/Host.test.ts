import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import Agreement from '../../../../../server/models/Agreement';
import { fakeCollective, fakeHost, fakeUploadedFile, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const hostQuery = gqlV2/* GraphQL */ `
  query Host($slug: String!) {
    host(slug: $slug) {
      id
      hostedAccountAgreements {
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
    it('should agreements with its hosted accounts', async () => {
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
      expect(result.data.host.hostedAccountAgreements.nodes).to.have.length(1);
      expect(result.data.host.hostedAccountAgreements.nodes[0].title).to.eql('test title');
      expect(result.data.host.hostedAccountAgreements.nodes[0].attachment).to.eql({
        name: 'my agreement.pdf',
      });
    });
  });
});
