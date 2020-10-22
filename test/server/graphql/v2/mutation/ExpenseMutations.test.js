import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import gqlV2 from 'fake-tag';
import { pick } from 'lodash';
import sinon from 'sinon';
import speakeasy from 'speakeasy';

import { expenseStatus } from '../../../../../server/constants';
import { payExpense } from '../../../../../server/graphql/v1/mutations/expenses.js';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { getFxRate } from '../../../../../server/lib/currency';
import models from '../../../../../server/models';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import paymentProviders from '../../../../../server/paymentProviders';
import { randEmail, randUrl } from '../../../../stores';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeExpenseItem,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, makeRequest } from '../../../../utils';

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

export const addFunds = async (user, hostCollective, collective, amount) => {
  const currency = collective.currency || 'USD';
  const hostCurrencyFxRate = await getFxRate(currency, hostCollective.currency);
  const amountInHostCurrency = Math.round(hostCurrencyFxRate * amount);
  await models.Transaction.create({
    CreatedByUserId: user.id,
    HostCollectiveId: hostCollective.id,
    type: 'CREDIT',
    amount,
    amountInHostCurrency,
    hostCurrencyFxRate,
    netAmountInCollectiveCurrency: amount,
    hostCurrency: hostCollective.currency,
    currency,
    CollectiveId: collective.id,
  });
};

const createExpenseMutation = gqlV2/* GraphQL */ `
  mutation CreateExpense($expense: ExpenseCreateInput!, $account: AccountReferenceInput!) {
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
  }
`;

const deleteExpenseMutation = gqlV2/* GraphQL */ `
  mutation DeleteExpense($expense: ExpenseReferenceInput!) {
    deleteExpense(expense: $expense) {
      id
      legacyId
    }
  }
`;

const editExpenseMutation = gqlV2/* GraphQL */ `
  mutation EditExpense($expense: ExpenseUpdateInput!) {
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
  }
`;

const processExpenseMutation = gqlV2/* GraphQL */ `
  mutation ProcessExpense(
    $expenseId: Int!
    $action: ExpenseProcessAction!
    $paymentParams: ProcessExpensePaymentParams
  ) {
    processExpense(expense: { legacyId: $expenseId }, action: $action, paymentParams: $paymentParams) {
      id
      legacyId
      status
    }
  }
`;

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
    let collective, host, collectiveAdmin, hostAdmin;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      host = await fakeCollective({ admin: hostAdmin.collective });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
      await hostAdmin.populateRoles();
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

        const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
        expect(transactions.length).to.eq(2);
      });

      it('handles concurency (should not create duplicate transactions)', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount * 3 });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const responses = await Promise.all([
          graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin),
          graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin),
        ]);

        await expense.reload();
        expect(expense.status).to.eq('PAID');
        const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
        expect(transactions.length).to.eq(2);

        const failure = responses.find(r => r.errors);
        const success = responses.find(r => r.data);
        expect(failure).to.exist;
        expect(success).to.exist;
        expect(success.data.processExpense.status).to.eq('PAID');
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

      it('Marks the expense as unpaid (with PayPal)', async () => {
        // Create a new collective to make sure the balance is empty
        const testCollective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
        const payoutMethod = await fakePayoutMethod({ type: 'PAYPAL' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: testCollective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: testCollective.id, amount: expense.amount });
        await payExpense(makeRequest(hostAdmin), { id: expense.id, forceManual: true });
        expect(await testCollective.getBalance()).to.eq(0);

        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
        expect(await testCollective.getBalance()).to.eq(expense.amount);
        await payExpense(makeRequest(hostAdmin), { id: expense.id, forceManual: true });
        expect(await testCollective.getBalance()).to.eq(0);
      });

      it('Marks the expense as unpaid', async () => {
        // Create a new collective to make sure the balance is empty
        const testCollective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: testCollective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({ type: 'CREDIT', CollectiveId: testCollective.id, amount: expense.amount });
        await payExpense(makeRequest(hostAdmin), { id: expense.id });
        expect(await testCollective.getBalance()).to.eq(0);

        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
        expect(await testCollective.getBalance()).to.eq(expense.amount);
      });

      it('Expense needs to be paid', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'REJECTED' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You don't have permission to mark this expense as unpaid");
      });
    });

    describe('SCHEDULE_FOR_PAYMENT', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You need to be authenticated to perform this action');
      });

      it('User cannot schedule their own expenses for payment', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You're authenticated but you can't schedule this expense for payment");
      });

      it('Collective admins cannot schedule expenses for payment', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You're authenticated but you can't schedule this expense for payment");
      });

      it('Expense needs to be approved', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'REJECTED' });
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq("You're authenticated but you can't schedule this expense for payment");
      });

      it('Schedules the expense for payment', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('SCHEDULED_FOR_PAYMENT');
      });

      it('Cannot scheduled for payment twice', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'SCHEDULED_FOR_PAYMENT',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        const mutationParams = { expenseId: expense.id, action: 'SCHEDULE_FOR_PAYMENT' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('Expense is already scheduled for payment');
      });
    });
  });

  describe('processExpense > PAY > with 2FA payouts', () => {
    const fee = 1.74;
    let collective, host, collectiveAdmin, hostAdmin, sandbox, expense1, expense2, expense3, expense4, user;

    before(() => {
      sandbox = sinon.createSandbox();
      sandbox.stub(paymentProviders.transferwise, 'payExpense').resolves({ quote: { fee } });
      sandbox.stub(paymentProviders.transferwise, 'getTemporaryQuote').resolves({ fee });
    });

    after(() => sandbox.restore());

    before(async () => {
      hostAdmin = await fakeUser();
      user = await fakeUser();
      collectiveAdmin = await fakeUser();
      host = await fakeCollective({
        admin: hostAdmin.collective,
        settings: { payoutsTwoFactorAuth: { enabled: true, rollingLimit: 50000 } },
      });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdmin.collective });
      await hostAdmin.populateRoles();
      await host.update({ plan: 'network-host-plan' });
      await addFunds(user, host, collective, 15000000);
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'transferwise',
        token: 'faketoken',
        data: { type: 'business', id: 0 },
      });
      const payoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          accountHolderName: 'Mopsa Mopsa',
          currency: 'EUR',
          type: 'iban',
          legalType: 'PRIVATE',
          details: {
            IBAN: 'DE89370400440532013000',
          },
        },
      });
      expense1 = await fakeExpense({
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 10000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense2 = await fakeExpense({
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 30000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense3 = await fakeExpense({
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 15000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense4 = await fakeExpense({
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 20000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
    });

    it('Tries to pay the expense but 2FA is enabled so the 2FA code needs to be entered', async () => {
      const mutationParams = { expenseId: expense1.id, action: 'PAY' };
      const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Host has two-factor authentication enabled for large payouts.');
    });

    it('Pays multiple expenses - 2FA is asked for the first time and after the limit is exceeded', async () => {
      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      await hostAdmin.update({ twoFactorAuthToken: encryptedToken });
      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });

      // process expense 1 giving 2FA the first time - limit will be set to 0/500
      const expenseMutationParams1 = {
        expenseId: expense1.id,
        action: 'PAY',
        paymentParams: { twoFactorAuthenticatorCode },
      };
      const result1 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams1, hostAdmin);

      expect(result1.errors).to.not.exist;
      expect(result1.data.processExpense.status).to.eq('PROCESSING');

      // process expense 2, no 2FA code - limit will be 300/500
      const expenseMutationParams2 = {
        expenseId: expense2.id,
        action: 'PAY',
      };
      const result2 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams2, hostAdmin);

      expect(result2.errors).to.not.exist;
      expect(result2.data.processExpense.status).to.eq('PROCESSING');

      // process expense 3, no 2FA code - limit will be 450/500
      const expenseMutationParams3 = {
        expenseId: expense3.id,
        action: 'PAY',
      };
      const result3 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams3, hostAdmin);

      expect(result3.errors).to.not.exist;
      expect(result3.data.processExpense.status).to.eq('PROCESSING');

      // process expense 4, no 2FA code - limit will be exceeded and we will be asked to enter the 2FA code again
      const expenseMutationParams4 = {
        expenseId: expense4.id,
        action: 'PAY',
      };
      const result4 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams4, hostAdmin);

      expect(result4.errors).to.exist;
      expect(result4.errors[0].message).to.eq(
        'Two-factor authentication payout limit exceeded: please re-enter your code.',
      );
    });
  });
});
