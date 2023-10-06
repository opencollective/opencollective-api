import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import {
  fakeCollective,
  fakeComment,
  fakeExpense,
  fakePayoutMethod,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { expectNoErrorsFromResult, graphqlQueryV2, resetTestDB, traverse } from '../../../../utils';

describe('server/graphql/v2/query/ExpenseQuery', () => {
  before(resetTestDB);

  describe('Permissions', () => {
    let expense,
      draftExpense,
      ownerUser,
      collectiveAdminUser,
      hostAdminUser,
      hostAccountantUser,
      randomUser,
      payoutMethod;

    const expenseQuery = gqlV2/* GraphQL */ `
      query Expense($id: Int!, $draftKey: String) {
        expense(expense: { legacyId: $id }, draftKey: $draftKey) {
          id
          draft
          payee {
            id
            name
            legalName
          }
          attachedFiles {
            url
          }
          items {
            id
            url
          }
          payoutMethod {
            id
            type
            data
          }
          permissions {
            approve {
              allowed
              reason
            }
          }
        }
      }
    `;

    before(async () => {
      ownerUser = await fakeUser({}, { legalName: 'A Legal Name' });
      hostAdminUser = await fakeUser();
      hostAccountantUser = await fakeUser();
      collectiveAdminUser = await fakeUser();
      randomUser = await fakeUser();
      const host = await fakeCollective({ admin: hostAdminUser.collective });
      await host.addUserWithRole(hostAccountantUser, 'ACCOUNTANT');
      const collective = await fakeCollective({ admin: collectiveAdminUser.collective, HostCollectiveId: host.id });
      payoutMethod = await fakePayoutMethod({ type: 'OTHER', data: { content: 'Test content' } });
      expense = await fakeExpense({
        FromCollectiveId: ownerUser.collective.id,
        CollectiveId: collective.id,
        PayoutMethodId: payoutMethod.id,
      });
      draftExpense = await fakeExpense({
        FromCollectiveId: ownerUser.collective.id,
        CollectiveId: collective.id,
        PayoutMethodId: payoutMethod.id,
        status: 'DRAFT',
        data: {
          draftKey: 'a-valid-draft-key',
          // Draft data
          description: 'A description',
          payeeLocation: { country: 'FR' },
          items: [
            {
              url: 'https://opencollective.com',
              amount: 1000,
              description: 'A description',
            },
          ],
          payee: {
            name: 'A name',
            slug: 'a-slug',
            id: 4242,
            legalName: 'A legal name',
            email: 'test@opencollective.com',
            organization: {
              name: 'An organization name',
            },
          },
        },
      });
    });

    it('can only see Payout method data if owner, collective admin, or host admin/accountant', async () => {
      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsOwner = await graphqlQueryV2(expenseQuery, queryParams, ownerUser);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
      const resultAsHostAdmin = await graphqlQueryV2(expenseQuery, queryParams, hostAdminUser);
      const resultAsHostAccountant = await graphqlQueryV2(expenseQuery, queryParams, hostAccountantUser);
      const resultAsRandomUser = await graphqlQueryV2(expenseQuery, queryParams, randomUser);

      // Check results
      expect(resultUnauthenticated.data.expense.payoutMethod.data).to.be.null;
      expect(resultAsRandomUser.data.expense.payoutMethod.data).to.be.null;
      expect(resultAsCollectiveAdmin.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
      expect(resultAsOwner.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
      expect(resultAsHostAdmin.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
      expect(resultAsHostAccountant.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
    });

    it('can only see uploaded files URLs if owner, or collective/host admin/accountant', async () => {
      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsOwner = await graphqlQueryV2(expenseQuery, queryParams, ownerUser);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
      const resultAsHostAdmin = await graphqlQueryV2(expenseQuery, queryParams, hostAdminUser);
      const resultAsRandomUser = await graphqlQueryV2(expenseQuery, queryParams, randomUser);
      const resultAsHostAccountant = await graphqlQueryV2(expenseQuery, queryParams, hostAccountantUser);

      // Check results
      const expectFilesToBeNull = data => {
        expect(data.expense.attachedFiles).to.be.null;
        data.expense.items.forEach(item => {
          expect(item.url).to.be.null;
        });
      };

      const expectFilesToNotBeNull = data => {
        expect(data.expense.attachedFiles).to.not.be.null;
        data.expense.items.forEach(item => {
          expect(item.url).to.not.be.null;
        });
      };

      expectFilesToBeNull(resultUnauthenticated.data);
      expectFilesToBeNull(resultAsRandomUser.data);
      expectFilesToNotBeNull(resultAsCollectiveAdmin.data);
      expectFilesToNotBeNull(resultAsHostAccountant.data);
      expectFilesToNotBeNull(resultAsOwner.data);
      expectFilesToNotBeNull(resultAsHostAdmin.data);
    });

    it('can only see payee legalName if self or host admin', async () => {
      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsOwner = await graphqlQueryV2(expenseQuery, queryParams, ownerUser);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
      const resultAsHostAccountant = await graphqlQueryV2(expenseQuery, queryParams, hostAccountantUser);
      const resultAsHostAdmin = await graphqlQueryV2(expenseQuery, queryParams, hostAdminUser);
      const resultAsRandomUser = await graphqlQueryV2(expenseQuery, queryParams, randomUser);

      // Check results
      expect(resultUnauthenticated.data.expense.payee.legalName).to.be.null;
      expect(resultAsRandomUser.data.expense.payee.legalName).to.be.null;
      expect(resultAsCollectiveAdmin.data.expense.payee.legalName).to.equal('A Legal Name');
      expect(resultAsHostAccountant.data.expense.payee.legalName).to.equal('A Legal Name');
      expect(resultAsOwner.data.expense.payee.legalName).to.equal('A Legal Name');
      expect(resultAsHostAdmin.data.expense.payee.legalName).to.equal('A Legal Name');
    });

    it('can fetch extended permission informations', async () => {
      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
      const resultAsHostAccountant = await graphqlQueryV2(expenseQuery, queryParams, hostAccountantUser);
      const resultAsRandomUser = await graphqlQueryV2(expenseQuery, queryParams, randomUser);

      expect(resultUnauthenticated.data.expense.permissions.approve).to.deep.equal({
        allowed: false,
        reason: 'UNSUPPORTED_USER_FEATURE',
      });

      expect(resultAsRandomUser.data.expense.permissions.approve).to.deep.equal({
        allowed: false,
        reason: 'MINIMAL_CONDITION_NOT_MET',
      });

      expect(resultAsCollectiveAdmin.data.expense.permissions.approve).to.deep.equal({
        allowed: true,
        reason: null,
      });

      expect(resultAsHostAccountant.data.expense.permissions.approve).to.deep.equal({
        allowed: false,
        reason: 'MINIMAL_CONDITION_NOT_MET',
      });
    });

    it('cannot see private details if not allowed', async () => {
      const queryParams = { id: draftExpense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsRandomUser = await graphqlQueryV2(expenseQuery, queryParams, randomUser);
      const expectedData = {
        items: [{ amount: 1000, description: 'A description' }],
        payee: {
          id: 4242,
          name: 'A name',
          organization: { name: 'An organization name' },
          slug: 'a-slug',
        },
      };

      expect(resultUnauthenticated.data.expense.draft).to.deep.eq(expectedData);
      expect(resultAsRandomUser.data.expense.draft).to.deep.eq(expectedData);
    });

    it('can see private details if allowed', async () => {
      // Query
      const queryParams = { id: draftExpense.id };
      const resultAsOwner = await graphqlQueryV2(expenseQuery, queryParams, ownerUser);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
      const resultAsHostAdmin = await graphqlQueryV2(expenseQuery, queryParams, hostAdminUser);
      const resultAsHostAccountant = await graphqlQueryV2(expenseQuery, queryParams, hostAccountantUser);
      const resultWithDraftKey = await graphqlQueryV2(expenseQuery, { ...queryParams, draftKey: 'a-valid-draft-key' });

      // Check results
      const expectedData = {
        items: [{ amount: 1000, description: 'A description', url: 'https://opencollective.com' }],
        payeeLocation: { country: 'FR' },
        payee: {
          id: 4242,
          email: 'test@opencollective.com',
          legalName: 'A legal name',
          name: 'A name',
          organization: { name: 'An organization name' },
          slug: 'a-slug',
        },
      };

      expect(resultWithDraftKey.data.expense.draft).to.deep.equal(expectedData);
      expect(resultAsCollectiveAdmin.data.expense.draft).to.deep.equal(expectedData);
      expect(resultAsOwner.data.expense.draft).to.deep.equal(expectedData);
      expect(resultAsHostAdmin.data.expense.draft).to.deep.equal(expectedData);
      expect(resultAsHostAccountant.data.expense.draft).to.deep.equal(expectedData);
    });
  });

  describe('query comments', () => {
    let collective, expense, collectiveAdmin;
    const expenseQuery = gqlV2/* GraphQL */ `
      query Expense($id: Int!, $limit: Int, $offset: Int) {
        expense(expense: { legacyId: $id }) {
          id
          comments(limit: $limit, offset: $offset) {
            totalCount
            nodes {
              id
              html
              createdAt
              account {
                id
                slug
                currency
                name
                ... on Collective {
                  host {
                    id
                    slug
                  }
                }
              }
            }
          }
        }
      }
    `;

    before(async () => {
      collectiveAdmin = await fakeUser();
      collective = await fakeCollective({ admin: collectiveAdmin.collective });
      expense = await fakeExpense({ CollectiveId: collective.id });
    });

    function populateComments() {
      const buildComment = params =>
        fakeComment({
          FromCollectiveId: collectiveAdmin.CollectiveId,
          ExpenseId: expense.id,
          CollectiveId: expense.CollectiveId,
          ...params,
        });

      return Promise.all(
        [
          { html: 'comment 2', createdAt: new Date('2018-01-02') },
          { html: 'comment 1', createdAt: new Date('2018-01-01') },
          { html: 'comment 8', createdAt: new Date('2018-01-08') },
          { html: 'comment 4', createdAt: new Date('2018-01-04') },
          { html: 'comment 5', createdAt: new Date('2018-01-05') },
          { html: 'comment 6', createdAt: new Date('2018-01-06') },
          { html: 'comment 7', createdAt: new Date('2018-01-07') },
          { html: 'comment 3', createdAt: new Date('2018-01-03') },
          { html: 'comment 9', createdAt: new Date('2018-01-09') },
          { html: 'comment 10', createdAt: new Date('2018-01-10') },
        ].map(buildComment),
      );
    }

    it('get an expense with associated comments empty (unauthenticated)', async () => {
      const result = await graphqlQueryV2(expenseQuery, { id: expense.id, limit: 5, offset: 0 });
      expectNoErrorsFromResult(result);
      expect(result.data.expense.comments).to.be.null;
    });

    it('get an expense with associated comments empty', async () => {
      const result = await graphqlQueryV2(expenseQuery, { id: expense.id, limit: 5, offset: 0 }, collectiveAdmin);
      expectNoErrorsFromResult(result);
      expect(result.data.expense.comments.totalCount).to.equal(0);
      expect(result.data.expense.comments.nodes).to.have.length(0);
    });

    it('get expense with associated comments', async () => {
      const comments = await populateComments();
      const limit = 5;
      const result = await graphqlQueryV2(expenseQuery, { id: expense.id, limit, offset: 0 }, collectiveAdmin);
      expectNoErrorsFromResult(result);
      expect(result.data.expense.comments.totalCount).to.equal(10);
      expect(result.data.expense.comments.nodes).to.have.length(5);

      // Check all fields returned are not null.
      traverse(result, (key, value) => {
        expect(value, key).to.not.be.null;
      });

      // Check comments are returned in the right order.
      comments.slice(0, limit).forEach((_, index) => {
        expect(result.data.expense.comments.nodes[index].html).to.equal(`comment ${index + 1}`);
      });
    });
  });
});
