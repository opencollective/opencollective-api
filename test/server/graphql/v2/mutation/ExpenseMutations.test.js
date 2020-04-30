import { expect } from 'chai';
import { pick } from 'lodash';

import { expenseStatus } from '../../../../../server/constants';
import { payExpense } from '../../../../../server/graphql/v1/mutations/expenses.js';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { randEmail, randUrl } from '../../../../stores';
import {
  fakeCollective,
  fakeExpense,
  fakeExpenseItem,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, makeRequest } from '../../../../utils';

const createExpenseMutation = `
mutation createExpense($expense: ExpenseCreateInput!, $account: AccountReferenceInput!) {
  createExpense(expense: $expense, account: $account) {
    id
    legacyId
    invoiceInfo
    amount
    payee {
      legacyId
    }
    payeeLocation {
      address
      country
    }
  }
}`;

const deleteExpenseMutation = `
mutation deleteExpense($expense: ExpenseReferenceInput!) {
  deleteExpense(expense: $expense) {
    id
    legacyId
  }
}`;

const editExpenseMutation = `
mutation editExpense($expense: ExpenseUpdateInput!) {
  editExpense(expense: $expense) {
    id
    legacyId
    invoiceInfo
    description
    type
    amount
    status
    privateMessage
    invoiceInfo
    payoutMethod {
      id
      data
      name
      type
    }
    payeeLocation {
      address
      country
    }
    items {
      id
      url
      amount
      incurredAt
      description
    }
    tags
  }
}`;

const processExpenseMutation = `
mutation processExpense($expenseId: Int!, $action: ExpenseProcessAction!, $paymentParams: ProcessExpensePaymentParams) {
  processExpense(expense: { legacyId: $expenseId }, action: $action, paymentParams: $paymentParams) {
    id
    legacyId
    status
  }
}`;

/** A small helper to prepare an expense item to be submitted to GQLV2 */
const convertExpenseItemId = item => {
  return item?.id ? { ...item, id: idEncode(item.id, IDENTIFIER_TYPES.EXPENSE_ITEM) } : item;
};

describe('server/graphql/v2/mutation/ExpenseMutations', () => {
  describe('createExpense', () => {
    const getValidExpenseData = () => ({
      description: 'A valid expense',
      type: 'INVOICE',
      invoiceInfo: 'This will be printed on your invoice',
      payoutMethod: { type: 'PAYPAL', data: { email: randEmail() } },
      items: [{ description: 'A first item', amount: 4200 }],
      payeeLocation: { address: '123 Potatoes street', country: 'BE' },
    });

    it('creates the expense with the linked items', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const payee = await fakeCollective({ type: 'ORGANIZATION', admin: user.collective, address: null });
      const expenseData = { ...getValidExpenseData(), payee: { legacyId: payee.id } };

      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.createExpense).to.exist;

      const createdExpense = result.data.createExpense;
      expect(createdExpense.invoiceInfo).to.eq(expenseData.invoiceInfo);
      expect(createdExpense.amount).to.eq(4200);
      expect(createdExpense.payee.legacyId).to.eq(payee.id);
      expect(createdExpense.payeeLocation).to.deep.equal(expenseData.payeeLocation);

      // Updates collective location
      await payee.reload();
      expect(payee.address).to.eq('123 Potatoes street');
      expect(payee.countryISO).to.eq('BE');
    });

    it("use collective's location if not provided", async () => {
      const user = await fakeUser({}, { address: '123 Potatoes Street', countryISO: 'BE' });
      const collective = await fakeCollective();
      const expenseData = {
        ...getValidExpenseData(),
        payee: { legacyId: user.collective.id },
        payeeLocation: undefined,
      };
      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const createdExpense = result.data.createExpense;
      expect(createdExpense.payeeLocation).to.deep.equal({
        address: '123 Potatoes Street',
        country: 'BE',
      });
    });

    it('must be an admin to submit expense as another account', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const payee = await fakeCollective({ type: 'ORGANIZATION' });
      const expenseData = { ...getValidExpenseData(), payee: { legacyId: payee.id } };

      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You must be an admin of the account to submit an expense in its name');
    });
  });

  describe('editExpense', () => {
    describe('goes back to pending if editing critical fields', () => {
      it('Payout', async () => {
        const expense2 = await fakeExpense({ status: 'APPROVED', legacyPayoutMethod: 'other' });
        const newPayoutMethod = await fakePayoutMethod({ CollectiveId: expense2.User.CollectiveId });
        const newExpense2Data = {
          id: idEncode(expense2.id, IDENTIFIER_TYPES.EXPENSE),
          payoutMethod: { id: idEncode(newPayoutMethod.id, IDENTIFIER_TYPES.PAYOUT_METHOD) },
        };
        const result2 = await graphqlQueryV2(editExpenseMutation, { expense: newExpense2Data }, expense2.User);
        expect(result2.errors).to.not.exist;
        expect(result2.data.editExpense.status).to.equal('PENDING');
      });

      it('Item(s)', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const newExpenseData = {
          id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
          items: { url: randUrl(), amount: 2000, description: randStr() },
        };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, expense.User);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.status).to.equal('PENDING');
      });

      it('Description => should not change status', async () => {
        const expense = await fakeExpense({ status: 'APPROVED' });
        const newExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), description: randStr() };
        const result = await graphqlQueryV2(editExpenseMutation, { expense: newExpenseData }, expense.User);
        expect(result.errors).to.not.exist;
        expect(result.data.editExpense.status).to.equal('APPROVED');
        expect(result.data.editExpense.amount).to.equal(expense.amount);
      });
    });

    it('replaces expense items', async () => {
      const expense = await fakeExpense({ amount: 3000 });
      const expenseUpdateData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        items: [
          {
            amount: 800,
            description: 'Burger',
            url: randUrl(),
          },
          {
            amount: 200,
            description: 'French Fries',
            url: randUrl(),
          },
        ],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: expenseUpdateData }, expense.User);
      const itemsFromAPI = result.data.editExpense.items;
      expect(result.data.editExpense.amount).to.equal(1000);
      expect(itemsFromAPI.length).to.equal(2);
      expenseUpdateData.items.forEach(item => {
        const itemFromAPI = itemsFromAPI.find(a => a.description === item.description);
        expect(itemFromAPI).to.exist;
        expect(itemFromAPI.url).to.equal(item.url);
        expect(itemFromAPI.amount).to.equal(item.amount);
      });
    });

    it('updates the items', async () => {
      const expense = await fakeExpense({ amount: 10000, items: [] });
      const items = (
        await Promise.all([
          fakeExpenseItem({ ExpenseId: expense.id, amount: 2000 }),
          fakeExpenseItem({ ExpenseId: expense.id, amount: 3000 }),
          fakeExpenseItem({ ExpenseId: expense.id, amount: 5000 }),
        ])
      ).map(convertExpenseItemId);

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        items: [
          pick(items[0], ['id', 'url', 'amount']), // Don't change the first one (value=2000)
          { ...pick(items[1], ['id', 'url']), amount: 7000 }, // Update amount for the second one
          { amount: 1000, url: randUrl() }, // Remove the third one and create another instead
        ],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.not.exist;
      const returnedItems = result.data.editExpense.items;
      const sumItems = returnedItems.reduce((total, item) => total + item.amount, 0);
      expect(sumItems).to.equal(10000);
      expect(returnedItems.find(a => a.id === items[0].id)).to.exist;
      expect(returnedItems.find(a => a.id === items[1].id)).to.exist;
      expect(returnedItems.find(a => a.id === items[2].id)).to.not.exist;
      expect(returnedItems.find(a => a.id === items[1].id).amount).to.equal(7000);
    });

    it('can edit only one field without impacting the others', async () => {
      const expense = await fakeExpense({ privateMessage: randStr(), description: randStr() });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), privateMessage: randStr() };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.data.editExpense.privateMessage).to.equal(updatedExpenseData.privateMessage);
      expect(result.data.editExpense.description).to.equal(expense.description);
    });

    it('updates the tags', async () => {
      const expense = await fakeExpense({ tags: [randStr()] });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), tags: ['fake', 'tags'] };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.data.editExpense.tags).to.deep.equal(updatedExpenseData.tags);
    });

    it('updates the location', async () => {
      const expense = await fakeExpense({ payeeLocation: { address: 'Base address', country: 'FR' } });
      const newLocation = { address: 'New address', country: 'BE' };
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), payeeLocation: newLocation };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      result.errors && console.error(result.errors);
      expect(result.data.editExpense.payeeLocation).to.deep.equal(updatedExpenseData.payeeLocation);
    });
  });

  describe('deleteExpense', () => {
    const prepareGQLParams = expense => ({ expense: { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE) } });

    describe('can delete rejected expenses', () => {
      it('if owner', async () => {
        const expense = await fakeExpense({ status: expenseStatus.REJECTED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), expense.User);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });

      it('if collective admin', async () => {
        const collectiveAdminUser = await fakeUser();
        const collective = await fakeCollective({ admin: collectiveAdminUser.collective });
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), collectiveAdminUser);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });

      it('if host admin', async () => {
        const hostAdminUser = await fakeUser();
        const host = await fakeCollective({ admin: hostAdminUser.collective });
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), hostAdminUser);

        expect(result.data.deleteExpense.legacyId).to.eq(expense.id);
        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.exist;
      });
    });

    describe('cannot delete', () => {
      it('if backer', async () => {
        const collectiveBackerUser = await fakeUser();
        const collective = await fakeCollective();
        await collective.addUserWithRole(collectiveBackerUser, 'BACKER');
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), collectiveBackerUser);

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      });

      it('if unauthenticated', async () => {
        const expense = await fakeExpense({ status: expenseStatus.REJECTED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense));

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
      });

      it('if not rejected', async () => {
        const expense = await fakeExpense({ status: expenseStatus.APPROVED });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), expense.User);

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      });
    });
  });

  describe('processExpense', () => {
    let collective, collectiveAdmin, hostAdmin;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      const host = await fakeCollective({ admin: hostAdmin.collective });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
    });

    describe('APPROVE', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
      });

      it('User cannot approve their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it('Approves the expense', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
      });

      it('Expense needs to be pending', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it("Doesn't crash for already-approved expenses", async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
      });
    });

    describe('UNAPPROVE', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'UNAPPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
      });

      it('User cannot unapprove their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'UNAPPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it('Unapproves the expense', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'UNAPPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('PENDING');
      });

      it('Expense needs to be approved', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it("Doesn't crash for already-pending expenses", async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'UNAPPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('PENDING');
      });
    });

    describe('REJECT', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
      });

      it('User cannot reject their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it('Rejects the expense', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('REJECTED');
      });

      it('Expense needs to be pending', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
      });

      it("Doesn't crash for already-rejected expenses", async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'REJECTED' });
        const mutationParams = { expenseId: expense.id, action: 'REJECT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('REJECTED');
      });
    });

    describe('PAY', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
      });

      it('User cannot pay their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to pay this expense");
      });

      it('Collective admins cannot pay expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to pay this expense");
      });

      it('Expense needs to be approved', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'REJECTED' });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          'Expense needs to be approved. Current status of the expense: REJECTED.',
        );
      });

      it('Pays the expense', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('PAID');
      });

      it('Cannot double-pay', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        const result2 = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('PAID');
        expect(result2.errors).to.exist;
        expect(result2.errors[0].message).to.eq('Expense has already been paid');
      });
    });

    describe('MARK_AS_UNPAID', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
      });

      it('User cannot mark as unpaid their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to mark this expense as unpaid");
      });

      it('Collective admins cannot mark expenses as unpaid', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to mark this expense as unpaid");
      });

      it('Only when the payout method type is "Other"', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'PAYPAL' });
        const expense = await fakeExpense({
          CollectiveId: collective.id,
          status: 'PAID',
          PayoutMethodId: payoutMethod.id,
        });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to mark this expense as unpaid");
      });

      it('Marks the expense as unpaid', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        await payExpense(makeRequest(hostAdmin), { id: expense.id });

        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
      });

      it('Expense needs to be paid', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'REJECTED' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to mark this expense as unpaid");
      });
    });
  });
});
