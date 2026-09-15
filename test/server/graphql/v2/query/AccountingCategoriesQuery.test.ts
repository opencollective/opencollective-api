import { expect } from 'chai';
import gql from 'fake-tag';

import roles from '../../../../../server/constants/roles';
import { fakeAccountingCategory, fakeActiveHost, fakeMember, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const accountingCategoriesQuery = gql`
  query AccountingCategories($slug: String!) {
    host(slug: $slug) {
      id
      accountingCategories {
        nodes {
          id
          code
          hostOnly
        }
      }
    }
  }
`;

describe('server/graphql/v2/query/AccountingCategoriesQuery', () => {
  describe('hostOnly categories visibility', () => {
    let host, hostAdmin, accountant, randomUser;

    before(async () => {
      hostAdmin = await fakeUser();
      accountant = await fakeUser();
      randomUser = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin });
      await fakeMember({
        CollectiveId: host.id,
        MemberCollectiveId: accountant.CollectiveId,
        role: roles.ACCOUNTANT,
      });
      await fakeAccountingCategory({ CollectiveId: host.id, code: 'PUBLIC', hostOnly: false });
      await fakeAccountingCategory({ CollectiveId: host.id, code: 'BALANCE', kind: 'BALANCE_ACCOUNT', hostOnly: true });
    });

    const getCodes = async remoteUser => {
      const result = await graphqlQueryV2(accountingCategoriesQuery, { slug: host.slug }, remoteUser);
      expect(result.errors).to.not.exist;
      return result.data.host.accountingCategories.nodes.map(node => node.code);
    };

    it('shows hostOnly categories to host admins', async () => {
      expect(await getCodes(hostAdmin)).to.have.members(['PUBLIC', 'BALANCE']);
    });

    it('shows hostOnly categories to host accountants', async () => {
      expect(await getCodes(accountant)).to.have.members(['PUBLIC', 'BALANCE']);
    });

    it('hides hostOnly categories from other users', async () => {
      expect(await getCodes(randomUser)).to.have.members(['PUBLIC']);
      expect(await getCodes(null)).to.have.members(['PUBLIC']);
    });
  });
});
