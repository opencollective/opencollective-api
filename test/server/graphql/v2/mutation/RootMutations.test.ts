import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { times } from 'lodash';

import { activities as ACTIVITY } from '../../../../../server/constants';
import roles from '../../../../../server/constants/roles';
import models from '../../../../../server/models';
import {
  fakeActivity,
  fakeCollective,
  fakeComment,
  fakeExpense,
  fakeMember,
  fakeRecurringExpense,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const MOVE_EXPENSES_MUTATION = gqlV2/* GraphQL */ `
  mutation MoveExpensesMutation($destinationAccount: AccountReferenceInput!, $expenses: [ExpenseReferenceInput!]!) {
    moveExpenses(destinationAccount: $destinationAccount, expenses: $expenses) {
      id
      account {
        id
      }
    }
  }
`;

describe('server/graphql/v2/mutation/RootMutations', () => {
  let rootUser;

  before(resetTestDB);
  before(async () => {
    rootUser = await fakeUser();
    await fakeMember({ CollectiveId: rootUser.id, MemberCollectiveId: 1, role: roles.ADMIN });
  });

  describe('moveExpensesMutation', () => {
    it('validates if request user is root', async () => {
      const result = await graphqlQueryV2(MOVE_EXPENSES_MUTATION, { expenses: [], destinationAccount: {} });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in.');
    });

    it('validates if destinationAccount argument is present', async () => {
      const result = await graphqlQueryV2(MOVE_EXPENSES_MUTATION, { expenses: [] }, rootUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'Variable "$destinationAccount" of required type "AccountReferenceInput!" was not provided.',
      );
    });

    it('validates if destinationAccount references an existing account', async () => {
      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { destinationAccount: { legacyId: -1 }, expenses: [{ legacyId: -1 }] },
        rootUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Account Not Found');
    });

    it('throws an error if one of the expense is missing', async () => {
      const collective = await fakeCollective();
      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { expenses: [{ legacyId: -1 }], destinationAccount: { legacyId: collective.id } },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Could not find expenses with ids: -1');
    });

    it('validates if destinationAccount references a non USER account', async () => {
      const testUser = await fakeUser();
      const expense = await fakeExpense();
      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { destinationAccount: { legacyId: testUser.CollectiveId }, expenses: [{ legacyId: expense.id }] },
        rootUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('The "destinationAccount" must not be an USER account');
    });

    it('moves no expenses when no expenses are given', async () => {
      const testCollective = await fakeCollective();

      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { destinationAccount: { legacyId: testCollective.id }, expenses: [] },
        rootUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.moveExpenses.length).to.equal(0);

      const testCollectiveExpenses = await models.Expense.findAll({
        where: {
          CollectiveId: testCollective.id,
        },
      });

      expect(testCollectiveExpenses.length).to.equal(0);
    });

    it('moves expenses and summarize the changes in MigrationLogs + Activities', async () => {
      const testCollective = await fakeCollective();
      const testExpense = await fakeExpense();
      const previousCollective = testExpense.collective;

      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { destinationAccount: { legacyId: testCollective.id }, expenses: [{ legacyId: testExpense.id }] },
        rootUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.moveExpenses.length).to.equal(1);

      const testCollectiveExpenses = await models.Expense.findAll({
        where: {
          CollectiveId: testCollective.id,
        },
      });

      expect(testCollectiveExpenses.length).to.equal(1);

      // Check migration logs
      const migrationLog = await models.MigrationLog.findOne({
        where: { type: 'MOVE_EXPENSES', CreatedByUserId: rootUser.id },
        order: [['createdAt', 'DESC']],
      });

      expect(migrationLog).to.exist;
      expect(migrationLog.data).to.deep.equal({
        expenses: [testExpense.id],
        recurringExpenses: [],
        destinationAccount: testCollective.id,
        previousExpenseValues: { [testExpense.id]: { CollectiveId: previousCollective.id } },
        activities: [],
        comments: [],
      });

      // Check activity
      const activity = await models.Activity.findOne({
        where: { ExpenseId: testExpense.id, type: ACTIVITY.COLLECTIVE_EXPENSE_MOVED },
      });

      expect(activity).to.exist;
      expect(activity.CollectiveId).to.equal(testCollective.id);
      expect(activity.data.movedFromCollective.id).to.equal(previousCollective.id);
      expect(activity.data.collective.id).to.equal(testCollective.id);
    });

    it('does not work yet with expenses that have transactions attached', async () => {
      const collective = await fakeCollective();
      const expense = await fakeExpense();
      await fakeTransaction({ ExpenseId: expense.id });
      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { destinationAccount: { legacyId: collective.id }, expenses: [{ legacyId: expense.id }] },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Cannot move expenses with associated transactions');
    });

    it('moves all associated comments and activities', async () => {
      const collective = await fakeCollective();
      const expense = await fakeExpense();
      const comments = await Promise.all([
        fakeComment({ ExpenseId: expense.id }),
        fakeComment({ ExpenseId: expense.id }),
      ]);
      const activities = await Promise.all([
        fakeActivity({ ExpenseId: expense.id, type: ACTIVITY.EXPENSE_COMMENT_CREATED }),
        fakeActivity({ ExpenseId: expense.id, type: ACTIVITY.COLLECTIVE_EXPENSE_CREATED }),
      ]);

      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { destinationAccount: { legacyId: collective.id }, expenses: [{ legacyId: expense.id }] },
        rootUser,
      );

      expect(result.errors).to.not.exist;

      // Reload all data
      await Promise.all([...comments, ...activities].map(commentOrActivity => commentOrActivity.reload()));

      // Check that all comments and activities are associated to the new collective
      expect(comments.map(comment => comment.CollectiveId)).to.deep.equal([collective.id, collective.id]);
      expect(activities.map(activity => activity.CollectiveId)).to.deep.equal([collective.id, collective.id]);
    });

    it('moves multiple expenses at once', async () => {
      const collective = await fakeCollective();
      const expenses = await Promise.all(times(3, () => fakeExpense()));
      const expenseReferences = expenses.map(expense => ({ legacyId: expense.id }));
      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { destinationAccount: { legacyId: collective.id }, expenses: expenseReferences },
        rootUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.moveExpenses.length).to.equal(3);

      const testCollectiveExpenses = await models.Expense.findAll({ where: { CollectiveId: collective.id } });
      expect(testCollectiveExpenses.length).to.equal(3);
    });

    it('updates the recurring expense', async () => {
      const previousCollective = await fakeCollective();
      const collective = await fakeCollective();
      const recurringExpense = await fakeRecurringExpense({ CollectiveId: previousCollective.id });
      const expense = await fakeExpense({
        CollectiveId: previousCollective.id,
        RecurringExpenseId: recurringExpense.id,
      });
      const result = await graphqlQueryV2(
        MOVE_EXPENSES_MUTATION,
        { destinationAccount: { legacyId: collective.id }, expenses: [{ legacyId: expense.id }] },
        rootUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.moveExpenses.length).to.equal(1);
      await recurringExpense.reload();
      expect(recurringExpense.CollectiveId).to.eq(collective.id);
    });
  });
});
