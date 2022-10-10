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
    let expense, ownerUser, collectiveAdminUser, hostAdminUser, randomUser, payoutMethod;

    const expenseQuery = gqlV2/* GraphQL */ `
      query Expense($id: Int!) {
        expense(expense: { legacyId: $id }) {
          id
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
      collectiveAdminUser = await fakeUser();
      randomUser = await fakeUser();
      const host = await fakeCollective({ admin: hostAdminUser.collective });
      const collective = await fakeCollective({ admin: collectiveAdminUser.collective, HostCollectiveId: host.id });
      payoutMethod = await fakePayoutMethod({ type: 'OTHER', data: { content: 'Test content' } });
      expense = await fakeExpense({
        FromCollectiveId: ownerUser.collective.id,
        CollectiveId: collective.id,
        PayoutMethodId: payoutMethod.id,
      });
    });

    it('can only see Payout method data if owner, or collective/host admin', async () => {
      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsOwner = await graphqlQueryV2(expenseQuery, queryParams, ownerUser);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
      const resultAsHostAdmin = await graphqlQueryV2(expenseQuery, queryParams, hostAdminUser);
      const resultAsRandomUser = await graphqlQueryV2(expenseQuery, queryParams, randomUser);

      // Check results
      expect(resultUnauthenticated.data.expense.payoutMethod.data).to.be.null;
      expect(resultAsRandomUser.data.expense.payoutMethod.data).to.be.null;
      expect(resultAsCollectiveAdmin.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
      expect(resultAsOwner.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
      expect(resultAsHostAdmin.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
    });

    it('can only see uploaded files URLs if owner, or collective/host admin', async () => {
      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsOwner = await graphqlQueryV2(expenseQuery, queryParams, ownerUser);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
      const resultAsHostAdmin = await graphqlQueryV2(expenseQuery, queryParams, hostAdminUser);
      const resultAsRandomUser = await graphqlQueryV2(expenseQuery, queryParams, randomUser);

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
      expectFilesToNotBeNull(resultAsOwner.data);
      expectFilesToNotBeNull(resultAsHostAdmin.data);
    });

    it('can only see payee legalName if self or host admin', async () => {
      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsOwner = await graphqlQueryV2(expenseQuery, queryParams, ownerUser);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
      const resultAsHostAdmin = await graphqlQueryV2(expenseQuery, queryParams, hostAdminUser);
      const resultAsRandomUser = await graphqlQueryV2(expenseQuery, queryParams, randomUser);

      // Check results
      expect(resultUnauthenticated.data.expense.payee.legalName).to.be.null;
      expect(resultAsRandomUser.data.expense.payee.legalName).to.be.null;
      expect(resultAsCollectiveAdmin.data.expense.payee.legalName).to.equal('A Legal Name');
      expect(resultAsOwner.data.expense.payee.legalName).to.equal('A Legal Name');
      expect(resultAsHostAdmin.data.expense.payee.legalName).to.equal('A Legal Name');
    });

    it('can fetch extended permission informations', async () => {
      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(expenseQuery, queryParams);
      const resultAsCollectiveAdmin = await graphqlQueryV2(expenseQuery, queryParams, collectiveAdminUser);
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
              collective {
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
