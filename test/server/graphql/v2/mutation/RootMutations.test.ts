import { expect } from 'chai';
import gql from 'fake-tag';
import { times } from 'lodash';

import { activities as ACTIVITY } from '../../../../../server/constants';
import { CollectiveType } from '../../../../../server/constants/collectives';
import PlatformConstants from '../../../../../server/constants/platform';
import roles from '../../../../../server/constants/roles';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import models from '../../../../../server/models';
import {
  fakeActivity,
  fakeCollective,
  fakeComment,
  fakeExpense,
  fakeHost,
  fakeMember,
  fakeRecurringExpense,
  fakeTransaction,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { generateValid2FAHeader, graphqlQueryV2, resetTestDB } from '../../../../utils';

const MOVE_EXPENSES_MUTATION = gql`
  mutation MoveExpenses($destinationAccount: AccountReferenceInput!, $expenses: [ExpenseReferenceInput!]!) {
    moveExpenses(destinationAccount: $destinationAccount, expenses: $expenses) {
      id
      account {
        id
      }
    }
  }
`;

const EDIT_ACCOUNT_TYPE_MUTATION = gql`
  mutation EditAccountType($account: AccountReferenceInput!) {
    editAccountType(account: $account) {
      id
      type
    }
  }
`;

describe('server/graphql/v2/mutation/RootMutations', () => {
  let rootUser;

  before(async () => {
    await resetTestDB();

    // Create user & add as root
    rootUser = await fakeUser({ data: { isRoot: true } }, null, { enable2FA: true });
    await fakeMember({ CollectiveId: rootUser.id, MemberCollectiveId: 1, role: roles.ADMIN });
  });

  describe('moveExpensesMutation', () => {
    const callMoveExpenseMutation = async (variables, user, useValid2FA = true) => {
      const headers = {};
      if (useValid2FA) {
        headers[TwoFactorAuthenticationHeader] = generateValid2FAHeader(rootUser);
      }

      return graphqlQueryV2(MOVE_EXPENSES_MUTATION, variables, user, undefined, headers);
    };

    it('validates if request user is logged in', async () => {
      const result = await callMoveExpenseMutation({ expenses: [], destinationAccount: {} }, null);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in.');
    });

    it('validates if request user is logged in as root', async () => {
      const randomUser = await fakeUser();
      const result = await callMoveExpenseMutation({ expenses: [], destinationAccount: {} }, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in as root.');
    });

    it('must have 2FA enabled', async () => {
      const rootUserWithout2FA = await fakeUser();
      await fakeMember({ CollectiveId: rootUserWithout2FA.id, MemberCollectiveId: 1, role: roles.ADMIN });
      const result = await callMoveExpenseMutation({ expenses: [], destinationAccount: {} }, rootUserWithout2FA);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in as root.');
    });

    it('validates if destinationAccount argument is present', async () => {
      const result = await callMoveExpenseMutation({ expenses: [] }, rootUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'Variable "$destinationAccount" of required type "AccountReferenceInput!" was not provided.',
      );
    });

    it('validates if destinationAccount references an existing account', async () => {
      const result = await callMoveExpenseMutation(
        { destinationAccount: { legacyId: -1 }, expenses: [{ legacyId: -1 }] },
        rootUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Account Not Found');
    });

    it('throws an error if one of the expense is missing', async () => {
      const collective = await fakeCollective();
      const result = await callMoveExpenseMutation(
        { expenses: [{ legacyId: -1 }], destinationAccount: { legacyId: collective.id } },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Could not find expenses with ids: -1');
    });

    it('validates if destinationAccount references a non USER account', async () => {
      const testUser = await fakeUser();
      const expense = await fakeExpense();
      const result = await callMoveExpenseMutation(
        { destinationAccount: { legacyId: testUser.CollectiveId }, expenses: [{ legacyId: expense.id }] },
        rootUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('The "destinationAccount" must not be an USER account');
    });

    it('moves no expenses when no expenses are given', async () => {
      const testCollective = await fakeCollective();

      const result = await callMoveExpenseMutation(
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

    it('moves expenses and summarize the changes in Activities', async () => {
      const testCollective = await fakeCollective();
      const testExpense = await fakeExpense();
      const previousCollective = testExpense.collective;

      const result = await callMoveExpenseMutation(
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
      const result = await callMoveExpenseMutation(
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

      const result = await callMoveExpenseMutation(
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
      const result = await callMoveExpenseMutation(
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
      const result = await callMoveExpenseMutation(
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

  describe('editAccountType', () => {
    const callEditAccountTypeMutation = async (variables, user, useValid2FA = true) => {
      const headers = {};
      if (useValid2FA) {
        headers[TwoFactorAuthenticationHeader] = generateValid2FAHeader(rootUser);
      }

      return graphqlQueryV2(EDIT_ACCOUNT_TYPE_MUTATION, variables, user, undefined, headers);
    };

    it('correctly converts a user profile to a org', async () => {
      const user = await fakeUser();
      const result = await callEditAccountTypeMutation({ account: { legacyId: user.collective.id } }, rootUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editAccountType.type).to.equal('ORGANIZATION');
    });

    it('prevents converting host accounts (even if they are USER type)', async () => {
      const host = await fakeUser(undefined, { hasMoneyManagement: true });
      const result = await callEditAccountTypeMutation({ account: { legacyId: host.collective.id } }, rootUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Cannot change type of host account');
    });

    it('prevents converting any other type of profile such as an collective', async () => {
      const collective = await fakeCollective();
      const result = await callEditAccountTypeMutation({ account: { legacyId: collective.id } }, rootUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('editAccountType only works on individual profiles');
    });

    it('prevents converting guest profiles to org', async () => {
      const user = await fakeUser(undefined, { data: { isGuest: true } });
      const result = await callEditAccountTypeMutation({ account: { legacyId: user.collective.id } }, rootUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('editAccountType does not work on guest profiles');
    });
  });

  describe('rootTransferBalance', () => {
    const ROOT_TRANSFER_BALANCE_MUTATION = gql`
      mutation RootTransferBalance(
        $fromAccount: AccountReferenceInput!
        $toAccount: AccountReferenceInput!
        $amount: AmountInput
        $message: String
      ) {
        rootTransferBalance(fromAccount: $fromAccount, toAccount: $toAccount, amount: $amount, message: $message) {
          id
          legacyId
          description
          amount {
            valueInCents
            currency
          }
          fromAccount {
            legacyId
          }
          toAccount {
            legacyId
          }
        }
      }
    `;

    const callTransferBalance = async (variables, user, useValid2FA = true) => {
      const headers = {};
      if (useValid2FA) {
        headers[TwoFactorAuthenticationHeader] = generateValid2FAHeader(rootUser);
      }
      return graphqlQueryV2(ROOT_TRANSFER_BALANCE_MUTATION, variables, user, undefined, headers);
    };

    it('rejects non-root users', async () => {
      const randomUser = await fakeUser();
      const result = await callTransferBalance(
        { fromAccount: { legacyId: 1 }, toAccount: { legacyId: 2 } },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in as root.');
    });

    it('requires 2FA', async () => {
      const rootUserNo2FAHeader = await fakeUser({ data: { isRoot: true } }, null, { enable2FA: true });
      const platformCollectiveId = PlatformConstants.PlatformCollectiveId || 1;
      const platformCollective =
        (await models.Collective.findByPk(platformCollectiveId)) ||
        (await fakeCollective({
          id: platformCollectiveId,
          HostCollectiveId: null,
          type: CollectiveType.ORGANIZATION,
        }));
      await fakeMember({
        CollectiveId: platformCollective.id,
        MemberCollectiveId: rootUserNo2FAHeader.CollectiveId,
        role: roles.ADMIN,
      });
      const host = await fakeHost();
      const fromCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const toCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });

      const result = await callTransferBalance(
        { fromAccount: { legacyId: fromCollective.id }, toAccount: { legacyId: toCollective.id } },
        rootUserNo2FAHeader,
        false,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Two-factor authentication required');
      expect(result.errors[0].extensions.code).to.equal('2FA_REQUIRED');
    });

    it('transfers full balance by default', async () => {
      const host = await fakeHost();
      const fromCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const toCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });

      // Give fromCollective a balance of 10000 cents ($100)
      await fakeTransaction(
        {
          CollectiveId: fromCollective.id,
          FromCollectiveId: fromCollective.id,
          HostCollectiveId: host.id,
          amount: 10000,
          currency: 'USD',
          kind: TransactionKind.CONTRIBUTION,
        },
        { createDoubleEntry: true },
      );

      const balanceBefore = await fromCollective.getBalance();
      expect(balanceBefore).to.equal(10000);

      const result = await callTransferBalance(
        {
          fromAccount: { legacyId: fromCollective.id },
          toAccount: { legacyId: toCollective.id },
          message: 'Zeroing balance for unhosting',
        },
        rootUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.rootTransferBalance.amount.valueInCents).to.equal(10000);
      expect(result.data.rootTransferBalance.description).to.equal('Zeroing balance for unhosting');
      expect(result.data.rootTransferBalance.fromAccount.legacyId).to.equal(fromCollective.id);
      expect(result.data.rootTransferBalance.toAccount.legacyId).to.equal(toCollective.id);

      // Verify source balance is now 0
      const balanceAfter = await fromCollective.getBalance();
      expect(balanceAfter).to.equal(0);

      // Verify destination balance increased
      const toBalanceAfter = await toCollective.getBalance();
      expect(toBalanceAfter).to.equal(10000);

      // Verify BALANCE_TRANSFER transactions exist
      const transactions = await models.Transaction.findAll({
        where: { kind: TransactionKind.BALANCE_TRANSFER, OrderId: result.data.rootTransferBalance.legacyId },
      });
      expect(transactions.length).to.be.greaterThan(0);

      // Verify order was created
      const order = await models.Order.findByPk(result.data.rootTransferBalance.legacyId);
      expect(order).to.exist;
      expect(order.status).to.equal('PAID');
      expect(order.data.isBalanceTransfer).to.be.true;
      expect(order.data.isRootBalanceTransfer).to.be.true;

      // Verify activity was created
      const activity = await models.Activity.findOne({
        where: { type: ACTIVITY.COLLECTIVE_BALANCE_TRANSFERRED, OrderId: order.id },
      });
      expect(activity).to.exist;
      expect(activity.data.amount).to.equal(10000);
    });

    it('transfers partial amount when amount arg is provided', async () => {
      const host = await fakeHost();
      const fromCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const toCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });

      await fakeTransaction(
        {
          CollectiveId: fromCollective.id,
          FromCollectiveId: fromCollective.id,
          HostCollectiveId: host.id,
          amount: 10000,
          currency: 'USD',
          kind: TransactionKind.CONTRIBUTION,
        },
        { createDoubleEntry: true },
      );

      const result = await callTransferBalance(
        {
          fromAccount: { legacyId: fromCollective.id },
          toAccount: { legacyId: toCollective.id },
          amount: { valueInCents: 3000, currency: 'USD' },
        },
        rootUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.rootTransferBalance.amount.valueInCents).to.equal(3000);

      // Source balance should be reduced by 3000
      const balanceAfter = await fromCollective.getBalance();
      expect(balanceAfter).to.equal(7000);

      // Destination balance should increase by 3000
      const toBalanceAfter = await toCollective.getBalance();
      expect(toBalanceAfter).to.equal(3000);
    });

    it('fails when amount exceeds balance', async () => {
      const host = await fakeHost();
      const fromCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const toCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });

      await fakeTransaction(
        {
          CollectiveId: fromCollective.id,
          FromCollectiveId: fromCollective.id,
          HostCollectiveId: host.id,
          amount: 5000,
          currency: 'USD',
          kind: TransactionKind.CONTRIBUTION,
        },
        { createDoubleEntry: true },
      );

      const result = await callTransferBalance(
        {
          fromAccount: { legacyId: fromCollective.id },
          toAccount: { legacyId: toCollective.id },
          amount: { valueInCents: 10000, currency: 'USD' },
        },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('exceeds available balance');
    });

    it('fails when source has no balance', async () => {
      const host = await fakeHost();
      const fromCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const toCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });

      const result = await callTransferBalance(
        {
          fromAccount: { legacyId: fromCollective.id },
          toAccount: { legacyId: toCollective.id },
        },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('must be greater than zero');
    });

    it('fails when account has no HostCollectiveId', async () => {
      const fromCollective = await fakeCollective({ HostCollectiveId: null });
      const toCollective = await fakeCollective({ HostCollectiveId: null });

      const result = await callTransferBalance(
        {
          fromAccount: { legacyId: fromCollective.id },
          toAccount: { legacyId: toCollective.id },
        },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('has no host');
    });

    it('fails when source and destination are the same account', async () => {
      const host = await fakeHost();
      const fromCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });

      const result = await callTransferBalance(
        {
          fromAccount: { legacyId: fromCollective.id },
          toAccount: { legacyId: fromCollective.id },
        },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('same account');
    });

    it('fails when accounts have different hosts', async () => {
      const host1 = await fakeHost();
      const host2 = await fakeHost();
      const fromCollective = await fakeCollective({ HostCollectiveId: host1.id, currency: 'USD' });
      const toCollective = await fakeCollective({ HostCollectiveId: host2.id, currency: 'USD' });

      const result = await callTransferBalance(
        {
          fromAccount: { legacyId: fromCollective.id },
          toAccount: { legacyId: toCollective.id },
        },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('different hosts');
    });

    it('fails when amount currency does not match host currency', async () => {
      const host = await fakeHost({ currency: 'USD' });
      const fromCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const toCollective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });

      const result = await callTransferBalance(
        {
          fromAccount: { legacyId: fromCollective.id },
          toAccount: { legacyId: toCollective.id },
          amount: { valueInCents: 1000, currency: 'EUR' },
        },
        rootUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Expected currency');
    });
  });
});
