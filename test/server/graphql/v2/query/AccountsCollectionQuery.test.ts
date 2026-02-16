import { expect } from 'chai';
import gql from 'fake-tag';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { fakeCollective } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const accountsQuery = gql`
  query Accounts(
    $account: [AccountReferenceInput!]
    $searchTerm: String
    $limit: Int
    $offset: Int
    $isActive: Boolean
  ) {
    accounts(account: $account, searchTerm: $searchTerm, limit: $limit, offset: $offset, isActive: $isActive) {
      totalCount
      limit
      offset
      nodes {
        id
        slug
        name
      }
    }
  }
`;

describe('server/graphql/v2/query/AccountsCollectionQuery', () => {
  before(resetTestDB);

  describe('account parameter', () => {
    it('fetches accounts by slug', async () => {
      const collective1 = await fakeCollective({ slug: 'test-collective-1', name: 'Test Collective 1' });
      const collective2 = await fakeCollective({ slug: 'test-collective-2', name: 'Test Collective 2' });
      await fakeCollective({ slug: 'test-collective-3', name: 'Test Collective 3' }); // Should not be returned

      const result = await graphqlQueryV2(accountsQuery, {
        account: [{ slug: 'test-collective-1' }, { slug: 'test-collective-2' }],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.accounts.totalCount).to.equal(2);
      expect(result.data.accounts.nodes).to.have.length(2);
      const slugs = result.data.accounts.nodes.map(n => n.slug);
      expect(slugs).to.include(collective1.slug);
      expect(slugs).to.include(collective2.slug);
    });

    it('fetches accounts by id', async () => {
      const collective = await fakeCollective({ name: 'Test By ID' });
      const encodedId = idEncode(collective.id, IDENTIFIER_TYPES.ACCOUNT);

      const result = await graphqlQueryV2(accountsQuery, {
        account: [{ id: encodedId }],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.accounts.totalCount).to.equal(1);
      expect(result.data.accounts.nodes[0].slug).to.equal(collective.slug);
    });

    it('fetches accounts by mixed references (id and slug)', async () => {
      const collective1 = await fakeCollective({ slug: 'mixed-ref-1', name: 'Mixed Ref 1' });
      const collective2 = await fakeCollective({ slug: 'mixed-ref-2', name: 'Mixed Ref 2' });
      const encodedId = idEncode(collective1.id, IDENTIFIER_TYPES.ACCOUNT);

      const result = await graphqlQueryV2(accountsQuery, {
        account: [{ id: encodedId }, { slug: 'mixed-ref-2' }],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.accounts.totalCount).to.equal(2);
      const slugs = result.data.accounts.nodes.map(n => n.slug);
      expect(slugs).to.include(collective1.slug);
      expect(slugs).to.include(collective2.slug);
    });

    it('returns empty array when no accounts match', async () => {
      const result = await graphqlQueryV2(accountsQuery, {
        account: [{ slug: 'non-existent-slug' }],
      });

      expect(result.errors).to.not.exist;
      expect(result.data.accounts.totalCount).to.equal(0);
      expect(result.data.accounts.nodes).to.have.length(0);
      expect(result.data.accounts.limit).to.equal(10);
      expect(result.data.accounts.offset).to.equal(0);
    });

    it('respects pagination (limit and offset)', async () => {
      const collectives = await Promise.all([
        fakeCollective({ slug: 'paginate-1' }),
        fakeCollective({ slug: 'paginate-2' }),
        fakeCollective({ slug: 'paginate-3' }),
      ]);

      const result = await graphqlQueryV2(accountsQuery, {
        account: collectives.map(c => ({ slug: c.slug })),
        limit: 2,
        offset: 1,
      });

      expect(result.errors).to.not.exist;
      expect(result.data.accounts.totalCount).to.equal(3);
      expect(result.data.accounts.nodes).to.have.length(2);
      expect(result.data.accounts.limit).to.equal(2);
      expect(result.data.accounts.offset).to.equal(1);
    });

    it('combines account filter with other filters', async () => {
      const collective1 = await fakeCollective({
        slug: 'combine-filter-1',
        name: 'Combine Filter Test',
        isActive: true,
      });
      const collective2 = await fakeCollective({
        slug: 'combine-filter-2',
        name: 'Combine Filter Test',
        isActive: false,
      });

      // Request both accounts but filter by isActive
      const result = await graphqlQueryV2(accountsQuery, {
        account: [{ slug: collective1.slug }, { slug: collective2.slug }],
        isActive: true,
      });

      expect(result.errors).to.not.exist;
      expect(result.data.accounts.totalCount).to.equal(1);
      expect(result.data.accounts.nodes[0].slug).to.equal(collective1.slug);
    });

    it('rejects requests with more than 200 account references', async () => {
      const accountReferences = Array.from({ length: 201 }, (_, i) => ({ slug: `test-slug-${i}` }));

      const result = await graphqlQueryV2(accountsQuery, {
        account: accountReferences,
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include(
        'Cannot provide more than 200 account references, please reduce the number of accounts',
      );
    });
  });
});
