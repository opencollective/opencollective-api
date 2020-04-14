import { expect } from 'chai';
import { pick } from 'lodash';

import { expenseStatus } from '../../../../../server/constants';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { randEmail, randUrl } from '../../../../stores';
import {
  fakeCollective,
  fakeExpense,
  fakeExpenseItem,
  fakePayoutMethod,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

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
    });

    it('creates the expense with the linked items', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const payee = await fakeCollective({ type: 'ORGANIZATION', admin: user.collective });
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
      console.log(result.errors[0]);

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
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), tags: ['FAKE', 'TAGS'] };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.data.editExpense.tags).to.deep.equal(updatedExpenseData.tags);
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
});
