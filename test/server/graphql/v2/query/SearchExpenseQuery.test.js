import { expect } from 'chai';

import { fakeCollective, fakeExpense, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const SEARCH_EXPENSE_QUERY = `
  query Expense($searchTerm: String!) {
    expenses (orderBy: {field: CREATED_AT}, searchTerm: $searchTerm) {
      nodes {
        description
        tags
        payee {
          name,
          slug
        }
      }
    }
  }
`;

describe('server/graphql/v2/query/SearchExpenseQuery', () => {
  describe('Search Expenses', () => {
    it('searches in description, expense tags and payee name', async () => {
      // Create data
      const ownerUser = await fakeUser();
      const hostAdminuser = await fakeUser();
      const collectiveAdminUser = await fakeUser();
      const host = await fakeCollective({ admin: hostAdminuser.collective });
      const collective = await fakeCollective({ admin: collectiveAdminUser.collective, HostCollectiveId: host.id });
      const expenseOne = {
        FromCollectiveId: ownerUser.collective.id,
        CollectiveId: collective.id,
        description: 'This is an expense by OpenCollective',
        tags: ['invoice', 'expense', 'opencollective'],
      };

      const expenseTwo = {
        FromCollectiveId: hostAdminuser.collective.id,
        CollectiveId: collective.id,
        description: 'This is another expense by engineering',
        tags: ['engineering', 'software', 'payout'],
      };
      await fakeExpense(expenseOne);
      await fakeExpense(expenseTwo);

      // Query
      const searchQueryForDescription = await graphqlQueryV2(SEARCH_EXPENSE_QUERY, { searchTerm: 'OpenCollective' });
      const searchQueryForTags = await graphqlQueryV2(SEARCH_EXPENSE_QUERY, { searchTerm: 'payout' });
      const searchQueryForName = await graphqlQueryV2(SEARCH_EXPENSE_QUERY, { searchTerm: ownerUser.collective.name });
      const searchQueryForSlug = await graphqlQueryV2(SEARCH_EXPENSE_QUERY, {
        searchTerm: hostAdminuser.collective.slug,
      });

      // Check for searching in description
      expect(searchQueryForDescription.data.expenses.nodes).to.deep.include({
        description: expenseOne.description,
        tags: expenseOne.tags,
        payee: { name: ownerUser.collective.name, slug: ownerUser.collective.slug },
      });
      expect(searchQueryForDescription.data.expenses.nodes).to.not.deep.include({
        description: expenseTwo.description,
        tags: expenseTwo.tags,
        payee: { name: hostAdminuser.collective.name, slug: hostAdminuser.collective.slug },
      });

      // Check for searching in tags
      expect(searchQueryForTags.data.expenses.nodes).to.deep.include({
        description: expenseTwo.description,
        tags: expenseTwo.tags,
        payee: { name: hostAdminuser.collective.name, slug: hostAdminuser.collective.slug },
      });
      expect(searchQueryForTags.data.expenses.nodes).to.not.deep.include({
        description: expenseOne.description,
        tags: expenseOne.tags,
        payee: { name: ownerUser.collective.name, slug: ownerUser.collective.slug },
      });

      // Check for searching in payees name
      expect(searchQueryForName.data.expenses.nodes).to.deep.include({
        description: expenseOne.description,
        tags: expenseOne.tags,
        payee: { name: ownerUser.collective.name, slug: ownerUser.collective.slug },
      });
      expect(searchQueryForName.data.expenses.nodes).to.not.deep.include({
        description: expenseTwo.description,
        tags: expenseTwo.tags,
        payee: { name: hostAdminuser.collective.name, slug: hostAdminuser.collective.slug },
      });

      // Check for searching in payees slug
      expect(searchQueryForSlug.data.expenses.nodes).to.deep.include({
        description: expenseTwo.description,
        tags: expenseTwo.tags,
        payee: { name: hostAdminuser.collective.name, slug: hostAdminuser.collective.slug },
      });
      expect(searchQueryForSlug.data.expenses.nodes).to.not.deep.include({
        description: expenseOne.description,
        tags: expenseOne.tags,
        payee: { name: ownerUser.collective.name, slug: ownerUser.collective.slug },
      });
    });
  });
});
