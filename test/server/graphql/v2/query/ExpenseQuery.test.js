import { expect } from 'chai';

import { fakeCollective, fakeExpense, fakePayoutMethod, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const EXPENSE_QUERY = `
  query Expense($id: Int!) {
    expense(expense: { legacyId: $id }) {
      id
      payoutMethod {
        id
        type
        data
      }
    }
  }
`;

describe('server/graphql/v2/query/ExpenseQuery', () => {
  describe('Payout method', () => {
    it('can only see data if owner, or collective/host admin', async () => {
      // Create data
      const ownerUser = await fakeUser();
      const hostAdminuser = await fakeUser();
      const collectiveAdminUser = await fakeUser();
      const randomUser = await fakeUser();
      const host = await fakeCollective({ admin: hostAdminuser.collective });
      const collective = await fakeCollective({ admin: collectiveAdminUser.collective, HostCollectiveId: host.id });
      const payoutMethod = await fakePayoutMethod({ type: 'OTHER', data: { content: 'Test content' } });
      const expense = await fakeExpense({
        FromCollectiveId: ownerUser.collective.id,
        CollectiveId: collective.id,
        PayoutMethodId: payoutMethod.id,
      });

      // Query
      const queryParams = { id: expense.id };
      const resultUnauthenticated = await graphqlQueryV2(EXPENSE_QUERY, queryParams);
      const resultAsOwner = await graphqlQueryV2(EXPENSE_QUERY, queryParams, ownerUser);
      const resultAsCollectiveAdmin = await graphqlQueryV2(EXPENSE_QUERY, queryParams, collectiveAdminUser);
      const resultAsHostAdmin = await graphqlQueryV2(EXPENSE_QUERY, queryParams, hostAdminuser);
      const resultAsRandomUser = await graphqlQueryV2(EXPENSE_QUERY, queryParams, randomUser);

      // Check results
      expect(resultUnauthenticated.data.expense.payoutMethod.data).to.be.null;
      expect(resultAsRandomUser.data.expense.payoutMethod.data).to.be.null;
      expect(resultAsCollectiveAdmin.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
      expect(resultAsOwner.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
      expect(resultAsHostAdmin.data.expense.payoutMethod.data).to.deep.equal(payoutMethod.data);
    });
  });
});
