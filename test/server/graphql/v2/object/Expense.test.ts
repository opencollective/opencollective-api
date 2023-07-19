import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import ActivityTypes from '../../../../../server/constants/activities.js';
import { fakeActivity, fakeExpense, fakeUser } from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2 } from '../../../../utils.js';

const expenseQuery = gqlV2/* GraphQL */ `
  query Expense($id: Int!) {
    expense(expense: { legacyId: $id }) {
      id
      approvedBy {
        legacyId
      }
    }
  }
`;

describe('server/graphql/v2/object/Expense', () => {
  describe('approvedBy', () => {
    it('should return approvers', async () => {
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();
      const expense = await fakeExpense();

      await fakeActivity({ ExpenseId: expense.id, UserId: user1.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user3.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });

      const result = await graphqlQueryV2(expenseQuery, { id: expense.id });
      expect(result.data.expense.approvedBy.length).to.eql(3);
      expect(result.data.expense.approvedBy[0].legacyId).to.eql(user1.collective.id);
      expect(result.data.expense.approvedBy[1].legacyId).to.eql(user2.collective.id);
      expect(result.data.expense.approvedBy[2].legacyId).to.eql(user3.collective.id);
    });

    it('should return approvers after last unapproved state', async () => {
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();
      const expense = await fakeExpense();

      await fakeActivity({ ExpenseId: expense.id, UserId: user1.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user3.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({
        ExpenseId: expense.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_UNAPPROVED,
      });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });

      const result = await graphqlQueryV2(expenseQuery, { id: expense.id });
      expect(result.data.expense.approvedBy.length).to.eql(1);
      expect(result.data.expense.approvedBy[0].legacyId).to.eql(user2.collective.id);
    });

    it('should return approvers after last re approval requested state', async () => {
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();
      const expense = await fakeExpense();

      await fakeActivity({ ExpenseId: expense.id, UserId: user1.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user3.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({
        ExpenseId: expense.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
      });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });

      const result = await graphqlQueryV2(expenseQuery, { id: expense.id });
      expect(result.data.expense.approvedBy.length).to.eql(1);
      expect(result.data.expense.approvedBy[0].legacyId).to.eql(user2.collective.id);
    });

    it('should return approvers after last rejection state', async () => {
      const user1 = await fakeUser();
      const user2 = await fakeUser();
      const user3 = await fakeUser();
      const expense = await fakeExpense();

      await fakeActivity({ ExpenseId: expense.id, UserId: user1.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({ ExpenseId: expense.id, UserId: user3.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });
      await fakeActivity({
        ExpenseId: expense.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
      });
      await fakeActivity({ ExpenseId: expense.id, UserId: user2.id, type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED });

      const result = await graphqlQueryV2(expenseQuery, { id: expense.id });
      expect(result.data.expense.approvedBy.length).to.eql(1);
      expect(result.data.expense.approvedBy[0].legacyId).to.eql(user2.collective.id);
    });
  });
});
