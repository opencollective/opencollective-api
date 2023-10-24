import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import { CollectiveType } from '../../../../../server/constants/collectives';
import { fakeActiveHost, fakeCollective, fakeExpense, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const accountQuery = gqlV2/* GraphQL */ `
  query Account($slug: String!, $forAccount: AccountReferenceInput, $searchTerm: String) {
    account(slug: $slug) {
      id
      vendors(forAccount: $forAccount, searchTerm: $searchTerm) {
        id
        type
        name
        slug
      }
    }
  }
`;

describe('server/graphql/v2/interface/Account', () => {
  describe('vendors', () => {
    let hostAdmin, host, account, vendor, knownVendor;
    before(async () => {
      hostAdmin = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin });
      account = await fakeCollective({ HostCollectiveId: host.id });
      vendor = await fakeCollective({
        ParentCollectiveId: host.id,
        type: CollectiveType.VENDOR,
        name: 'Vendor Dafoe',
      });
      knownVendor = await fakeCollective({
        ParentCollectiveId: host.id,
        type: CollectiveType.VENDOR,
        name: 'Vendor 2',
        settings: { disablePublicExpenseSubmission: true },
      });
      await fakeExpense({ CollectiveId: account.id, FromCollectiveId: knownVendor.id, status: 'PAID' });
    });

    it('should return all vendors if admin of Account', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: host.slug }, hostAdmin);

      expect(result.data.account.vendors).to.containSubset([{ slug: vendor.slug }, { slug: knownVendor.slug }]);
    });

    it('should only vendors with public expense policy if not admin of Account', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(accountQuery, { slug: host.slug }, user);

      expect(result.data.account.vendors).to.containSubset([{ slug: vendor.slug }]);
    });

    it('should return vendors ranked by the number of expenses submitted to specific account', async () => {
      const result = await graphqlQueryV2(
        accountQuery,
        { slug: host.slug, forAccount: { slug: account.slug } },
        hostAdmin,
      );

      expect(result.data.account.vendors).to.containSubset([{ slug: vendor.slug }, { slug: knownVendor.slug }]);
      expect(result.data.account.vendors[0]).to.include({ slug: knownVendor.slug });
    });

    it('should search vendor by searchTerm', async () => {
      const result = await graphqlQueryV2(accountQuery, { slug: host.slug, searchTerm: 'dafoe' }, hostAdmin);

      expect(result.data.account.vendors).to.have.length(1);
      expect(result.data.account.vendors[0]).to.include({ slug: vendor.slug });
    });
  });
});
