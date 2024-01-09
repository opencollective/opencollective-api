import { expect } from 'chai';
import gql from 'fake-tag';

import Agreement from '../../../../../server/models/Agreement';
import { fakeCollective, fakeHost, fakeUploadedFile, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const accountQuery = gql`
  query Account($slug: String!) {
    account(slug: $slug) {
      id
      ... on AccountWithHost {
        hostAgreements {
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
  }
`;

describe('server/graphql/v2/object/AccountWithHost', () => {
  describe('hostAgreements', () => {
    it('should agreements with its host', async () => {
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

      const result = await graphqlQueryV2(accountQuery, { slug: account.slug }, hostAdmin);
      expect(result.data.account.hostAgreements.nodes).to.have.length(1);
      expect(result.data.account.hostAgreements.nodes[0].title).to.eql('test title');
      expect(result.data.account.hostAgreements.nodes[0].attachment).to.eql({
        name: 'my agreement.pdf',
      });
    });
  });
});
