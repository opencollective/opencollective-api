import { expect } from 'chai';
import config from 'config';
import crypto from 'crypto-js';
import gqlV2 from 'fake-tag';
import { defaultsDeep, omit, pick, round, sumBy } from 'lodash';
import { createSandbox } from 'sinon';
import speakeasy from 'speakeasy';

import { expenseStatus, expenseTypes } from '../../../../../server/constants';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { payExpense } from '../../../../../server/graphql/common/expenses';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import { getFxRate } from '../../../../../server/lib/currency';
import emailLib from '../../../../../server/lib/email';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import models from '../../../../../server/models';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import paymentProviders from '../../../../../server/paymentProviders';
import paypalAdaptive from '../../../../../server/paymentProviders/paypal/adaptiveGateway';
import { randEmail, randUrl } from '../../../../stores';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeExpenseItem,
  fakeHost,
  fakeOrganization,
  fakePaymentMethod,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  fakeVirtualCard,
  multiple,
  randStr,
} from '../../../../test-helpers/fake-data';
import {
  graphqlQueryV2,
  makeRequest,
  preloadAssociationsForTransactions,
  resetTestDB,
  snapshotTransactions,
  waitForCondition,
} from '../../../../utils';

const SECRET_KEY = config.dbEncryption.secretKey;
const CIPHER = config.dbEncryption.cipher;

const SNAPSHOT_COLUMNS = [
  'type',
  'amount',
  'netAmountInCollectiveCurrency',
  'paymentProcessorFeeInHostCurrency',
  'currency',
  'hostCurrency',
  'hostCurrencyFxRate',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'isRefund',
];

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

const mutationExpenseFields = gqlV2/* GraphQL */ `
  fragment ExpenseFields on Expense {
    id
    legacyId
    invoiceInfo
    amount
    invoiceInfo
    description
    type
    amount
    status
    privateMessage
    invoiceInfo
    taxes {
      id
      type
      rate
    }
    payee {
      legacyId
      id
      name
      slug
    }
    payeeLocation {
      address
      country
    }
    createdByAccount {
      legacyId
      name
      slug
    }
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
`;

const createExpenseMutation = gqlV2/* GraphQL */ `
  mutation CreateExpense($expense: ExpenseCreateInput!, $account: AccountReferenceInput!) {
    createExpense(expense: $expense, account: $account) {
      ...ExpenseFields
    }
  }
  ${mutationExpenseFields}
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
  mutation EditExpense($expense: ExpenseUpdateInput!, $draftKey: String) {
    editExpense(expense: $expense, draftKey: $draftKey) {
      ...ExpenseFields
    }
  }
  ${mutationExpenseFields}
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

const REFUND_SNAPSHOT_COLS = [
  ...['type', 'kind', 'isRefund', 'CollectiveId', 'FromCollectiveId'],
  ...['amount', 'amountInHostCurrency', 'paymentProcessorFeeInHostCurrency', 'netAmountInCollectiveCurrency'],
];

/** A small helper to prepare an expense item to be submitted to GQLV2 */
const convertExpenseItemId = item => {
  return item?.id ? { ...item, id: idEncode(item.id, IDENTIFIER_TYPES.EXPENSE_ITEM) } : item;
};

describe('server/graphql/v2/mutation/ExpenseMutations', () => {
  before(async () => {
    // It seems that a previous test doesn't free the sendMessage stub. This corrects it
    await resetTestDB();
    if (emailLib.sendMessage.restore) {
      emailLib.sendMessage.restore();
    }
  });

  describe('createExpense', () => {
    let sandbox, emailSendMessageSpy;
    const getValidExpenseData = () => ({
      description: 'A valid expense',
      type: 'INVOICE',
      invoiceInfo: 'This will be printed on your invoice',
      payoutMethod: { type: 'PAYPAL', data: { email: randEmail() } },
      items: [{ description: 'A first item', amount: 4200 }],
      payeeLocation: { address: '123 Potatoes street', country: 'BE' },
    });

    beforeEach(() => {
      sandbox = createSandbox();
      emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
    });

    afterEach(() => {
      emailSendMessageSpy.restore();
      sandbox.restore();
    });

    it('fails if not logged in', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const expenseData = getValidExpenseData();
      const result = await graphqlQueryV2(createExpenseMutation, {
        expense: { ...expenseData, payee: { legacyId: user.CollectiveId } },
        account: { legacyId: collective.id },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it(`fails if it's not an allowed expense type`, async () => {
      const user = await fakeUser();
      const expenseData = { ...getValidExpenseData(), type: 'INVOICE', payee: { legacyId: user.CollectiveId } };

      // Because of the collective settings
      let collective = await fakeCollective({ settings: { expenseTypes: { INVOICE: false } } });
      let result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type invoice are not allowed by the account');

      // Because of the parent settings
      const parent = await fakeCollective({ settings: { expenseTypes: { INVOICE: false } } });
      collective = await fakeCollective({ ParentCollectiveId: parent.id });
      result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type invoice are not allowed by the parent');

      // Because of the host settings
      const host = await fakeHost({ settings: { expenseTypes: { INVOICE: false } } });
      collective = await fakeCollective({ HostCollectiveId: host.id });
      result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type invoice are not allowed by the host');
    });

    it('creates the expense with the linked items', async () => {
      const user = await fakeUser();
      const collectiveAdmin = await fakeUser();
      const collective = await fakeCollective({ admin: collectiveAdmin.collective });
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

      // And then an email should have been sent to the admin. This
      // call to the function `waitForCondition()` is required because
      // notifications are sent asynchronously.
      await waitForCondition(() => emailSendMessageSpy.callCount === 1);
      expect(emailSendMessageSpy.callCount).to.equal(1);
      expect(emailSendMessageSpy.firstCall.args[0]).to.equal(collectiveAdmin.email);
      expect(emailSendMessageSpy.firstCall.args[1]).to.equal(
        `New expense on ${collective.name}: $42.00 for A valid expense`,
      );
      expect(emailSendMessageSpy.firstCall.args[2]).to.contain(
        `/${collective.slug}/expenses/${createdExpense.legacyId}`,
      );
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

    it('with VAT', async () => {
      const collective = await fakeCollective({
        currency: 'EUR',
        settings: { VAT: { type: 'OWN', idNumber: 'XXXXXX' } },
      });

      const user = await fakeUser();
      const expenseData = {
        ...getValidExpenseData(),
        payee: { legacyId: user.CollectiveId },
        tax: [{ type: 'VAT', rate: 0.2 }],
        items: [
          { description: 'First item', amount: 4200 },
          { description: 'Second item', amount: 5800 },
        ],
      };
      const result = await graphqlQueryV2(
        createExpenseMutation,
        { expense: expenseData, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultExpense = result.data.createExpense;
      const returnedItems = resultExpense.items;
      const sumItems = sumBy(returnedItems, 'amount');
      expect(sumItems).to.equal(10000);
      expect(resultExpense.amount).to.equal(12000); // items sum + 20% tax
      expect(resultExpense.taxes[0].type).to.equal('VAT');
      expect(resultExpense.taxes[0].rate).to.equal(0.2);
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
          convertExpenseItemId(pick(items[0]['dataValues'], ['id', 'url', 'amount'])), // Don't change the first one (value=2000)
          convertExpenseItemId({ ...pick(items[1]['dataValues'], ['id', 'url']), amount: 7000 }), // Update amount for the second one
          { amount: 8000, url: randUrl() }, // Remove the third one and create another instead
        ],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const returnedItems = result.data.editExpense.items;
      const sumItems = returnedItems.reduce((total, item) => total + item.amount, 0);

      expect(sumItems).to.equal(17000);
      expect(result.data.editExpense.amount).to.equal(17000);
      expect(returnedItems.find(a => a.id === items[0].id)).to.exist;
      expect(returnedItems.find(a => a.id === items[1].id)).to.exist;
      expect(returnedItems.find(a => a.id === items[2].id)).to.not.exist;
      expect(returnedItems.find(a => a.id === items[1].id).amount).to.equal(7000);
    });

    it('adding VAT updates the amount', async () => {
      const collective = await fakeCollective({
        currency: 'EUR',
        settings: { VAT: { type: 'OWN', idNumber: 'XXXXXX' } },
      });
      const expense = await fakeExpense({
        type: expenseTypes.INVOICE,
        amount: 10000,
        items: [],
        CollectiveId: collective.id,
      });
      await Promise.all([
        fakeExpenseItem({ ExpenseId: expense.id, amount: 2000 }),
        fakeExpenseItem({ ExpenseId: expense.id, amount: 3000 }),
        fakeExpenseItem({ ExpenseId: expense.id, amount: 5000 }),
      ]);

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        tax: [{ type: 'VAT', rate: 0.055 }],
      };

      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const returnedItems = result.data.editExpense.items;
      const sumItems = sumBy(returnedItems, 'amount');

      expect(sumItems).to.equal(10000);
      expect(result.data.editExpense.amount).to.equal(10550); // items sum + 5.5% tax
      expect(result.data.editExpense.taxes[0].type).to.equal('VAT');
      expect(result.data.editExpense.taxes[0].rate).to.equal(0.055);
    });

    it('can edit only one field without impacting the others', async () => {
      const expense = await fakeExpense({ privateMessage: randStr(), description: randStr() });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), privateMessage: randStr() };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.data.editExpense.privateMessage).to.equal(updatedExpenseData.privateMessage);
      expect(result.data.editExpense.description).to.equal(expense.description);
    });

    it('cannot update info if the expense is PAID', async () => {
      const expense = await fakeExpense({ status: 'PAID' });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), privateMessage: randStr() };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq("You don't have permission to edit this expense");
    });

    it(`fails if it's not an allowed expense type`, async () => {
      // Because of the collective settings
      let collective = await fakeCollective({ settings: { expenseTypes: { RECEIPT: false } } });
      let expense = await fakeExpense({ status: 'PENDING', type: 'INVOICE', CollectiveId: collective.id });
      let updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), type: 'RECEIPT' };
      let result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type receipt are not allowed by the account');

      // Because of the parent settings
      const parent = await fakeCollective({ settings: { expenseTypes: { RECEIPT: false } } });
      collective = await fakeCollective({ ParentCollectiveId: parent.id });
      expense = await fakeExpense({ status: 'PENDING', type: 'INVOICE', CollectiveId: collective.id });
      updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), type: 'RECEIPT' };
      result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type receipt are not allowed by the parent');

      // Because of the host settings
      const host = await fakeHost({ settings: { expenseTypes: { RECEIPT: false } } });
      collective = await fakeCollective({ HostCollectiveId: host.id });
      expense = await fakeExpense({ status: 'PENDING', type: 'INVOICE', CollectiveId: collective.id });
      updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), type: 'RECEIPT' };
      result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, expense.User);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expenses of type receipt are not allowed by the host');
    });

    it('can update the tags as admin (even if the expense is PAID)', async () => {
      const adminUser = await fakeUser();
      const collective = await fakeCollective({ admin: adminUser.collective });
      const expense = await fakeExpense({ tags: [randStr()], status: 'PAID', CollectiveId: collective.id });
      const updatedExpenseData = { id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE), tags: ['fake', 'tags'] };
      const result = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, adminUser);
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

    it('lets another user edit and submit a draft if the right key is provided', async () => {
      const expense = await fakeExpense({ data: { draftKey: 'fake-key' }, status: expenseStatus.DRAFT });
      const anotherUser = await fakeUser();

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        description: 'This is a test.',
        payee: {
          legacyId: anotherUser.id,
        },
      };

      const { errors } = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData }, anotherUser);
      expect(errors).to.exist;
      expect(errors[0]).to.have.nested.property('extensions.code', 'Unauthorized');

      const result = await graphqlQueryV2(
        editExpenseMutation,
        {
          expense: updatedExpenseData,
          draftKey: 'fake-key',
        },
        anotherUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editExpense.description).to.equal(updatedExpenseData.description);
      expect(result.data.editExpense.payee.legacyId).to.equal(anotherUser.id);
    });

    it('creates new user and organization if draft payee does not exist', async () => {
      const expense = await fakeExpense({ data: { draftKey: 'fake-key' }, status: expenseStatus.DRAFT });
      const anotherUser = await fakeUser();

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        description: 'This is a test.',
        payee: {
          name: 'New Folk',
          email: randEmail(),
          organization: {
            name: 'Folk Ventures',
            slug: randStr('folk-'),
          },
        },
      };

      const { errors } = await graphqlQueryV2(editExpenseMutation, { expense: updatedExpenseData });
      expect(errors).to.exist;
      expect(errors[0]).to.have.nested.property('extensions.code', 'Unauthorized');

      const result = await graphqlQueryV2(
        editExpenseMutation,
        {
          expense: updatedExpenseData,
          draftKey: 'fake-key',
        },
        anotherUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      expect(result.data.editExpense.description).to.equal(updatedExpenseData.description);
      expect(result.data.editExpense.payee.slug).to.equal(updatedExpenseData.payee.organization.slug);

      const user = await models.User.findOne({ where: { email: updatedExpenseData.payee.email } });
      expect(user).to.exist;
    });

    it('resets paid card charge expense missing details status', async () => {
      const user = await fakeUser();
      const virtualCard = await fakeVirtualCard();
      const expense = await fakeExpense({
        data: { missingDetails: true },
        status: expenseStatus.PAID,
        type: expenseTypes.CHARGE,
        VirtualCardId: virtualCard.id,
        amount: 2000,
        CollectiveId: user.CollectiveId,
        UserId: user.id,
      });
      const item = await fakeExpenseItem({ ExpenseId: expense.id, amount: 2000 }).then(convertExpenseItemId);

      const updatedExpenseData = {
        id: idEncode(expense.id, IDENTIFIER_TYPES.EXPENSE),
        description: 'Credit Card charge',
        items: [
          {
            ...pick(item, ['id', 'url', 'amount']),
            description: 'totally valid beer',
            url: 'http://opencollective.com/cool/story/bro',
          },
        ],
      };

      const result = await graphqlQueryV2(
        editExpenseMutation,
        {
          expense: updatedExpenseData,
        },
        expense.User,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      await expense.reload();
      expect(expense).to.have.nested.property('data.missingDetails').eq(false);

      // Ensure activity is created
      const activities = await expense.getActivities({ where: { type: 'collective.expense.updated' } });
      expect(activities).to.have.length(1);
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
      it('if not logged in as author, admin or host', async () => {
        const randomUser = await fakeUser();
        const collective = await fakeCollective();
        const expense = await fakeExpense({ status: expenseStatus.REJECTED, CollectiveId: collective.id });
        const result = await graphqlQueryV2(deleteExpenseMutation, prepareGQLParams(expense), randomUser);

        await expense.reload({ paranoid: false });
        expect(expense.deletedAt).to.not.exist;
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          "You don't have permission to delete this expense or it needs to be rejected before being deleted",
        );
      });

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
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
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
    let collective, host, collectiveAdmin, hostAdmin, hostPaypalPm;

    before(async () => {
      await resetTestDB();
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      host = await fakeCollective({
        name: 'OSC',
        admin: hostAdmin.collective,
        plan: 'network-host-plan',
        currency: 'USD',
      });
      collective = await fakeCollective({
        name: 'Babel',
        HostCollectiveId: host.id,
        admin: collectiveAdmin.collective,
        currency: 'USD',
      });
      await hostAdmin.populateRoles();
      hostPaypalPm = await fakePaymentMethod({
        name: randEmail(),
        service: 'paypal',
        type: 'adaptive',
        CollectiveId: host.id,
        token: 'abcdefg',
        confirmedAt: new Date(),
      });
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'transferwise',
        token: 'faketoken',
        data: { type: 'business', id: 0 },
      });
    });

    describe('APPROVE', () => {
      let sandbox, emailSendMessageSpy;

      beforeEach(() => {
        sandbox = createSandbox();
        emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
      });

      afterEach(() => {
        emailSendMessageSpy.restore();
        sandbox.restore();
      });

      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      });

      it('User cannot approve their own expenses', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, expense.User);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('You are authenticated but forbidden to perform this action');
        expect(result.errors[0].extensions.code).to.equal('Forbidden');
      });

      it('Approves the expense', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PENDING' });
        const mutationParams = { expenseId: expense.id, action: 'APPROVE' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, collectiveAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');

        // Send emails to host admin and author
        await waitForCondition(() => emailSendMessageSpy.callCount === 2);
        expect(emailSendMessageSpy.callCount).to.equal(2);
        expect(emailSendMessageSpy.firstCall.args[0]).to.equal(expense.User.email);
        expect(emailSendMessageSpy.firstCall.args[1]).to.contain('Your expense');
        expect(emailSendMessageSpy.firstCall.args[1]).to.contain('has been approved');
        expect(emailSendMessageSpy.secondCall.args[0]).to.equal(hostAdmin.email);
        expect(emailSendMessageSpy.secondCall.args[1]).to.contain('New expense approved');
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
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
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
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
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
      let sandbox, emailSendMessageSpy;

      beforeEach(() => {
        sandbox = createSandbox();
        emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');
      });

      afterEach(() => {
        emailSendMessageSpy.restore();
        sandbox.restore();
      });

      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'APPROVED' });
        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
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

      it('Expense needs to be approved or error', async () => {
        const statuses = Object.keys(omit(expenseStatus, ['APPROVED', 'ERROR', 'SCHEDULED_FOR_PAYMENT']));
        for (const status of statuses) {
          const expense = await fakeExpense({ status, CollectiveId: collective.id });
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          expect(result.errors).to.exist;
          if (expense.status === expenseStatus.PROCESSING) {
            expect(result.errors[0].message).to.eq(
              `Expense is currently being processed, this means someone already started the payment process`,
            );
          } else if (expense.status === expenseStatus.PAID) {
            expect(result.errors[0].message).to.eq(`Expense has already been paid`);
          } else {
            expect(result.errors[0].message).to.eq(
              `Expense needs to be approved. Current status of the expense: ${expense.status}.`,
            );
          }
          // Remove expense so we don't affect next tests
          await expense.destroy({ force: true });
        }
      });

      it('Fails if balance is too low', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          'Collective does not have enough funds to pay this expense. Current balance: $0.00, Expense amount: $10.00.',
        );
      });

      it('Fails if balance is too low to cover the fees', async () => {
        const payoutMethod = await fakePayoutMethod({ type: 'PAYPAL' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        const mutationParams = { expenseId: expense.id, action: 'PAY' };
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq(
          'Collective does not have enough funds to cover for the fees of this payment method. Current balance: $10.00, Expense amount: $10.00, Estimated PAYPAL fees: $0.69.',
        );
      });

      it('Pays the expense manually', async () => {
        const paymentProcessorFee = 100;
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        // Updates the collective balance and pay the expense
        const initialBalance = await collective.getBalanceWithBlockedFunds();
        const expensePlusFees = expense.amount + paymentProcessorFee;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expensePlusFees });
        expect(await collective.getBalanceWithBlockedFunds()).to.equal(initialBalance + expensePlusFees);
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expensePlusFees,
            forceManual: true,
          },
        };
        emailSendMessageSpy.resetHistory();
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(await collective.getBalanceWithBlockedFunds()).to.equal(initialBalance);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');

        // Check transactions
        const debitTransaction = await models.Transaction.findOne({
          where: {
            type: 'DEBIT',
            ExpenseId: expense.id,
          },
        });

        expect(debitTransaction.kind).to.equal(TransactionKind.EXPENSE);
        expect(debitTransaction.currency).to.equal(expense.currency);
        expect(debitTransaction.hostCurrency).to.equal(host.currency);
        expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-expensePlusFees);
        expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(
          Math.round(-paymentProcessorFee * debitTransaction.hostCurrencyFxRate),
        );
        const creditTransaction = await models.Transaction.findOne({
          where: {
            type: 'CREDIT',
            ExpenseId: expense.id,
          },
        });
        expect(creditTransaction.kind).to.equal(TransactionKind.EXPENSE);
        expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expense.amount);
        expect(creditTransaction.amount).to.equal(expensePlusFees);

        // Check activity
        const activities = await expense.getActivities({ where: { type: 'collective.expense.paid' } });
        expect(activities.length).to.equal(1);
        expect(activities[0].data.host.id).to.equal(host.id);
        expect(activities[0].TransactionId).to.equal(debitTransaction.id);

        // Check sent emails
        await waitForCondition(() => emailSendMessageSpy.callCount === 2);
        expect(emailSendMessageSpy.callCount).to.equal(2);
        expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
        expect(emailSendMessageSpy.args[0][2]).to.contain(`has been paid`);
        expect(emailSendMessageSpy.args[1][0]).to.equal(hostAdmin.email);
        expect(emailSendMessageSpy.args[1][1]).to.contain(`Expense paid for ${collective.name}`);

        // User should be added as a CONTRIBUTOR
        const membership = await models.Member.findOne({
          where: { MemberCollectiveId: expense.FromCollectiveId, CollectiveId: collective.id, role: 'CONTRIBUTOR' },
        });
        expect(membership).to.exist;
      });

      it('Pays the expense manually (Collective currency != Host currency)', async () => {
        const host = await fakeCollective({
          name: 'OC EU',
          admin: hostAdmin.collective,
          plan: 'network-host-plan',
          currency: 'EUR',
        });
        const collective = await fakeCollective({
          name: 'UK',
          HostCollectiveId: host.id,
          admin: collectiveAdmin.collective,
          currency: 'GBP',
        });
        const paymentProcessorFee = 61;
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 4400,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
          currency: 'GBP',
        });

        // Updates the collective balance and pay the expense
        await fakeTransaction({
          type: 'CREDIT',
          CollectiveId: collective.id,
          amount: 100e2,
          netAmountInCollectiveCurrency: 100e2,
          amountInHostCurrency: 100e2,
          currency: 'GBP',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1.1,
        });
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: 5058,
            forceManual: true,
          },
        };
        emailSendMessageSpy.resetHistory();
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');

        // Check transactions
        const debitTransaction = await models.Transaction.findOne({
          where: {
            type: 'DEBIT',
            ExpenseId: expense.id,
          },
        });

        expect(debitTransaction.kind).to.equal(TransactionKind.EXPENSE);
        expect(debitTransaction.currency).to.equal(expense.currency);
        expect(debitTransaction.hostCurrency).to.equal(host.currency);
        expect(debitTransaction.hostCurrencyFxRate).to.equal(1.13568);
        expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-4400 - round(61 / 1.13568));
        expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(-61);

        const creditTransaction = await models.Transaction.findOne({
          where: {
            type: 'CREDIT',
            ExpenseId: expense.id,
          },
        });
        expect(creditTransaction.kind).to.equal(TransactionKind.EXPENSE);
        expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expense.amount);
        expect(creditTransaction.amount).to.equal(4400 + round(61 / 1.13568));

        // Check activity
        const activities = await expense.getActivities({ where: { type: 'collective.expense.paid' } });
        expect(activities.length).to.equal(1);
        expect(activities[0].data.host.id).to.equal(host.id);
        expect(activities[0].TransactionId).to.equal(debitTransaction.id);

        // Check sent emails
        await waitForCondition(() => emailSendMessageSpy.callCount === 2);
        expect(emailSendMessageSpy.callCount).to.equal(2);
        expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
        expect(emailSendMessageSpy.args[0][2]).to.contain(`has been paid`);
        expect(emailSendMessageSpy.args[1][0]).to.equal(hostAdmin.email);
        expect(emailSendMessageSpy.args[1][1]).to.contain(`Expense paid for ${collective.name}`);

        // User should be added as a CONTRIBUTOR
        const membership = await models.Member.findOne({
          where: { MemberCollectiveId: expense.FromCollectiveId, CollectiveId: collective.id, role: 'CONTRIBUTOR' },
        });
        expect(membership).to.exist;
      });

      it('attaches the PayoutMethod to the associated Transactions', async () => {
        const paymentProcessorFee = 100;
        const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
        const expense = await fakeExpense({
          amount: 1000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
        });

        const expensePlusFees = expense.amount + paymentProcessorFee;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expensePlusFees });
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            forceManual: true,
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expensePlusFees,
          },
        };
        await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);

        const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });

        expect(transactions.every(tx => tx.PayoutMethodId === expense.PayoutMethodId)).to.equal(true);
      });

      describe('With PayPal', () => {
        it('fails if not enough funds on the paypal preapproved key', async () => {
          const callPaypal = sandbox.stub(paypalAdaptive, 'callPaypal').callsFake(() => {
            return Promise.reject(
              new Error(
                'PayPal error: The total amount of all payments exceeds the maximum total amount for all payments (error id: 579031)',
              ),
            );
          });

          const fromUser = await fakeUser();
          const payoutMethod = await fakePayoutMethod({ type: 'PAYPAL', CollectiveId: fromUser.CollectiveId });
          const expense = await fakeExpense({
            amount: 1000,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            UserId: fromUser.id,
            FromCollectiveId: fromUser.CollectiveId,
          });

          // Updates the collective balance and pay the expense
          const estimatedPayPalFees = 1000;
          await fakeTransaction({
            type: 'CREDIT',
            CollectiveId: collective.id,
            amount: expense.amount + estimatedPayPalFees,
          });

          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          expect(callPaypal.firstCall.args[0]).to.equal('pay');
          expect(callPaypal.firstCall.args[1].currencyCode).to.equal(expense.currency);
          expect(callPaypal.firstCall.args[1].memo).to.include('Reimbursement from');
          expect(callPaypal.firstCall.args[1].memo).to.include(expense.description);
          expect(res.errors).to.exist;
          expect(res.errors[0].message).to.contain('Not enough funds in your existing Paypal preapproval');
          const updatedExpense = await models.Expense.findByPk(expense.id);
          expect(updatedExpense.status).to.equal('APPROVED');
          const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
          expect(transactions.length).to.equal(0);
          transactions.forEach(transaction => expect(transaction.kind).to.eq(TransactionKind.Expense));
        });

        it('when hosts paypal and payout method paypal are the same', async () => {
          const callPaypal = sandbox.stub(paypalAdaptive, 'callPaypal');
          const fromUser = await fakeUser();
          const payoutMethod = await fakePayoutMethod({
            type: 'PAYPAL',
            CollectiveId: fromUser.CollectiveId,
            data: { email: hostPaypalPm.name },
          });
          const expense = await fakeExpense({
            amount: 1000,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            UserId: fromUser.id,
            FromCollectiveId: fromUser.CollectiveId,
          });

          // Updates the collective balance and pay the expense
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });

          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;
          expect(res.data.processExpense.status).to.equal('PAID');
          expect(callPaypal.called).to.be.false;
        });
      });

      describe('With transferwise', () => {
        const fee = 1.74;
        let getTemporaryQuote, expense;
        const quote = {
          payOut: 'BANK_TRANSFER',
          paymentOptions: [
            {
              payInProduct: 'BALANCE',
              fee: { total: fee },
              payIn: 'BALANCE',
              sourceCurrency: 'USD',
              targetCurrency: 'EUR',
              payOut: 'BANK_TRANSFER',
              disabled: false,
            },
          ],
        };

        before(async () => {
          // Updates the collective balance and pay the expense
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 15000000 });
        });

        beforeEach(() => {
          getTemporaryQuote = sandbox.stub(paymentProviders.transferwise, 'getTemporaryQuote').resolves(quote);
          sandbox.stub(paymentProviders.transferwise, 'payExpense').resolves({ quote });
        });

        beforeEach(async () => {
          const user = await fakeUser();
          const payoutMethod = await fakePayoutMethod({
            type: PayoutMethodTypes.BANK_ACCOUNT,
            CollectiveId: user.CollectiveId,
            data: {
              accountHolderName: 'Leo Kewitz',
              currency: 'EUR',
              type: 'iban',
              legalType: 'PRIVATE',
              details: {
                IBAN: 'DE89370400440532013000',
              },
            },
          });
          expense = await fakeExpense({
            payoutMethod: 'transferwise',
            status: expenseStatus.APPROVED,
            amount: 1000000,
            FromCollectiveId: user.CollectiveId,
            CollectiveId: collective.id,
            UserId: user.id,
            currency: 'USD',
            PayoutMethodId: payoutMethod.id,
            category: 'Engineering',
            type: 'INVOICE',
            description: 'January Invoice',
          });
        });

        it('includes TransferWise fees', async () => {
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;
          await expense.reload();

          expect(getTemporaryQuote.called).to.be.true;
          expect(expense)
            .to.have.nested.property('data.feesInHostCurrency.paymentProcessorFeeInHostCurrency')
            .to.equal(Math.round(fee * 100));
        });

        it('should update expense status to PROCESSING', async () => {
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;
          await expense.reload();
          expect(expense.status).to.equal(expenseStatus.PROCESSING);
        });

        it('should send a notification email to the payee', async () => {
          emailSendMessageSpy.resetHistory();
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const res = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;
          await waitForCondition(() => emailSendMessageSpy.callCount === 1);
          expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
          expect(emailSendMessageSpy.args[0][1]).to.contain(
            `Payment being processed: January Invoice for ${collective.name}`,
          );
        });

        it('attaches the PayoutMethod to the associated Transactions', async () => {
          await host.update({
            settings: defaultsDeep(host.settings, { transferwise: { ignorePaymentProcessorFees: true } }),
          });
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });

          expect(transactions.every(tx => tx.PayoutMethodId === expense.PayoutMethodId)).to.equal(true);
        });
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
        result.errors && console.error(result.errors);
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

      it('pays 100% of the balance by putting the fees on the payee', async () => {
        const paymentProcessorFee = 575;
        const fromOrganization = await fakeOrganization({ name: 'Facebook' });
        const payoutMethod = await fakePayoutMethod({ type: 'BANK_ACCOUNT', CollectiveId: fromOrganization.id });
        const collective = await fakeCollective({ name: 'Webpack', HostCollectiveId: host.id });
        const expense = await fakeExpense({
          amount: 10000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
          FromCollectiveId: fromOrganization.id,
        });

        // Updates the balances
        const initialOrgBalance = 42000;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        await fakeTransaction({ type: 'CREDIT', CollectiveId: fromOrganization.id, amount: initialOrgBalance });

        // Check initial balances
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(10000);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(initialOrgBalance);

        // Pay expense
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expense.amount,
            forceManual: true,
            feesPayer: 'PAYEE',
          },
        };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');

        // Check balance (post-payment)
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(0);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(
          initialOrgBalance + expense.amount - paymentProcessorFee,
        );

        // Marks the expense as unpaid (aka. refund transaction)
        await graphqlQueryV2(
          processExpenseMutation,
          {
            expenseId: expense.id,
            action: 'MARK_AS_UNPAID',
            paymentParams: {
              shouldRefundPaymentProcessorFee: true, // Also refund payment processor fees
            },
          },
          hostAdmin,
        );

        const allTransactions = await models.Transaction.findAll({
          where: { ExpenseId: expense.id },
          order: [['id', 'ASC']],
        });

        // Snapshot
        await preloadAssociationsForTransactions(allTransactions, REFUND_SNAPSHOT_COLS);
        snapshotTransactions(allTransactions, { columns: REFUND_SNAPSHOT_COLS });

        // Check balances (post-refund)
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(10000);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(initialOrgBalance);

        // Check individual transactions
        await Promise.all(allTransactions.map(t => t.validate()));
        const getTransaction = type =>
          models.Transaction.findOne({ where: { type, ExpenseId: expense.id }, order: [['id', 'ASC']] });

        const debitTransaction = await getTransaction('DEBIT');
        const expectedFee = Math.round(paymentProcessorFee * debitTransaction.hostCurrencyFxRate);
        expect(debitTransaction.amount).to.equal(-expense.amount + expectedFee);
        expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-expense.amount);
        expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(-expectedFee);

        const creditTransaction = await getTransaction('CREDIT');
        expect(creditTransaction.amount).to.equal(expense.amount);
        expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expense.amount - expectedFee);
        expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(-expectedFee);
      });

      it('pays 100% of the balance by putting the fees on the payee but do not refund processor fees', async () => {
        const paymentProcessorFee = 575;
        const fromOrganization = await fakeOrganization({ name: 'Facebook' });
        const payoutMethod = await fakePayoutMethod({ type: 'BANK_ACCOUNT', CollectiveId: fromOrganization.id });
        const collective = await fakeCollective({ name: 'Webpack', HostCollectiveId: host.id });
        const expense = await fakeExpense({
          amount: 10000,
          CollectiveId: collective.id,
          status: 'APPROVED',
          PayoutMethodId: payoutMethod.id,
          FromCollectiveId: fromOrganization.id,
        });

        // Updates the balances
        const initialOrgBalance = 42000;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: expense.amount });
        await fakeTransaction({ type: 'CREDIT', CollectiveId: fromOrganization.id, amount: initialOrgBalance });

        // Check initial balances
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(10000);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(initialOrgBalance);

        // Pay expense
        const mutationParams = {
          expenseId: expense.id,
          action: 'PAY',
          paymentParams: {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expense.amount,
            forceManual: true,
            feesPayer: 'PAYEE',
          },
        };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        result.errors && console.error(result.errors);
        expect(result.data.processExpense.status).to.eq('PAID');

        // Check balance (post-payment)
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(0);
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(
          initialOrgBalance + expense.amount - paymentProcessorFee,
        );

        // Marks the expense as unpaid (aka. refund transaction)
        await graphqlQueryV2(
          processExpenseMutation,
          {
            expenseId: expense.id,
            action: 'MARK_AS_UNPAID',
            paymentParams: {
              shouldRefundPaymentProcessorFee: false, // Do not refund payment processor fees
            },
          },
          hostAdmin,
        );

        const allTransactions = await models.Transaction.findAll({
          where: { ExpenseId: expense.id },
          order: [['id', 'ASC']],
        });

        // Snapshot
        await preloadAssociationsForTransactions(allTransactions, REFUND_SNAPSHOT_COLS);
        snapshotTransactions(allTransactions, { columns: REFUND_SNAPSHOT_COLS });

        // Check balances (post-refund)
        expect(await collective.getBalanceWithBlockedFunds()).to.eq(9425); // Fees are lost in the process
        expect(await fromOrganization.getBalanceWithBlockedFunds()).to.eq(initialOrgBalance);

        // Check transactions
        await Promise.all(allTransactions.map(t => t.validate()));
        const getTransaction = type =>
          models.Transaction.findOne({ where: { type, ExpenseId: expense.id }, order: [['id', 'ASC']] });

        const debitTransaction = await getTransaction('DEBIT');
        const expectedFee = Math.round(paymentProcessorFee * debitTransaction.hostCurrencyFxRate);
        expect(debitTransaction.amount).to.equal(-expense.amount + expectedFee);
        expect(debitTransaction.amountInHostCurrency).to.equal(-expense.amount + expectedFee);
        expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(-expense.amount);
        expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(-expectedFee);
        await models.Transaction.validate(debitTransaction);

        const creditTransaction = await getTransaction('CREDIT');
        expect(creditTransaction.amount).to.equal(expense.amount);
        expect(creditTransaction.amountInHostCurrency).to.equal(expense.amount);
        expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expense.amount - expectedFee);
        expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(-expectedFee);
        await models.Transaction.validate(creditTransaction);
      });

      it('can only put fees on the payee for bank account', async () => {
        // Updates the collective balance and pay the expense
        const amount = 10000;
        await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount });
        const testWithPayoutMethodType = async type => {
          const paymentProcessorFee = 100;
          const payoutMethod = await fakePayoutMethod({ type });
          const fromCollective = type === 'ACCOUNT_BALANCE' && (await fakeCollective());
          const expense = await fakeExpense({
            amount,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            FromCollectiveId: fromCollective.id,
          });

          const paymentParams = {
            paymentProcessorFeeInHostCurrency: paymentProcessorFee,
            totalAmountPaidInHostCurrency: expense.amount,
            forceManual: true,
            feesPayer: 'PAYEE',
          };
          const mutationParams = { expenseId: expense.id, action: 'PAY', paymentParams };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.match(
            /^Putting the payment processor fees on the payee is only supported for/,
          );
        };

        await testWithPayoutMethodType('ACCOUNT_BALANCE');
        await testWithPayoutMethodType('PAYPAL');
      });

      describe('Multi-currency expense', () => {
        it('Pays the expense manually', async () => {
          const paymentProcessorFeeInHostCurrency = 100;
          const totalAmountPaidInHostCurrency = 1700;
          const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
          const payee = await fakeCollective({ name: 'Payee', HostCollectiveId: null });
          const expense = await fakeExpense({
            amount: 100e2,
            FromCollectiveId: payee.id,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            currency: 'BRL', // collective & hosts are defined in USD in `before`
          });

          // Updates the collective balance and pay the expense
          const initialBalance = await collective.getBalanceWithBlockedFunds();
          const expenseAmountInCollectiveCurrency = totalAmountPaidInHostCurrency - paymentProcessorFeeInHostCurrency;
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: totalAmountPaidInHostCurrency });
          expect(await collective.getBalanceWithBlockedFunds()).to.equal(
            initialBalance + totalAmountPaidInHostCurrency,
          );
          emailSendMessageSpy.resetHistory();
          const mutationParams = {
            expenseId: expense.id,
            action: 'PAY',
            paymentParams: { paymentProcessorFeeInHostCurrency, totalAmountPaidInHostCurrency, forceManual: true },
          };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          result.errors && console.error(result.errors);
          expect(result.errors).to.not.exist;
          expect(result.data.processExpense.status).to.eq('PAID');
          expect(await collective.getBalanceWithBlockedFunds()).to.equal(initialBalance);

          // Check transactions
          const expenseTransactions = await models.Transaction.findAll({
            where: { ExpenseId: expense.id },
            order: [['id', 'DESC']],
          });

          await preloadAssociationsForTransactions(expenseTransactions, SNAPSHOT_COLUMNS);
          snapshotTransactions(expenseTransactions, { columns: SNAPSHOT_COLUMNS });

          const debitTransaction = expenseTransactions.find(({ type }) => type === 'DEBIT');
          expect(debitTransaction.amount).to.equal(-expenseAmountInCollectiveCurrency);
          expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(-paymentProcessorFeeInHostCurrency);
          expect(debitTransaction.currency).to.equal(collective.currency);
          expect(debitTransaction.hostCurrency).to.equal(host.currency); // same as collective.currency
          expect(debitTransaction.hostCurrencyFxRate).to.equal(1); // host & collective have the same currency
          expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(
            -expenseAmountInCollectiveCurrency - paymentProcessorFeeInHostCurrency,
          );

          const creditTransaction = expenseTransactions.find(({ type }) => type === 'CREDIT');
          expect(creditTransaction.amount).to.equal(
            expenseAmountInCollectiveCurrency + paymentProcessorFeeInHostCurrency,
          );
          expect(creditTransaction.currency).to.equal(collective.currency);
          expect(creditTransaction.hostCurrency).to.equal(host.currency);
          expect(creditTransaction.hostCurrencyFxRate).to.equal(1);
          expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expenseAmountInCollectiveCurrency);
          expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(-paymentProcessorFeeInHostCurrency);

          // Check sent emails
          await waitForCondition(() => emailSendMessageSpy.callCount === 2);
          expect(emailSendMessageSpy.callCount).to.equal(2);
          // Email to payee
          expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
          expect(emailSendMessageSpy.args[0][1]).to.contain('R$100.00'); // title
          expect(emailSendMessageSpy.args[0][2]).to.contain(`has been paid`); // content
          expect(emailSendMessageSpy.args[0][2]).to.contain('R$100.00');
          // Email to collective
          expect(emailSendMessageSpy.args[1][0]).to.equal(hostAdmin.email);
          expect(emailSendMessageSpy.args[1][1]).to.contain(`Expense paid for ${collective.name}`);
        });

        it('Records a manual payment with an active account', async () => {
          const paymentProcessorFeeInHostCurrency = 100;
          const totalAmountPaidInHostCurrency = 1700;
          const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
          const payeeHost = await fakeHost({ currency: 'NZD', name: 'PayeeHost' });
          const payee = await fakeCollective({ name: 'Payee', HostCollectiveId: payeeHost.id });
          const expense = await fakeExpense({
            amount: 100e2,
            FromCollectiveId: payee.id,
            CollectiveId: collective.id,
            status: 'APPROVED',
            PayoutMethodId: payoutMethod.id,
            currency: 'BRL', // collective & hosts are defined in USD in `before`
          });

          // Updates the collective balance and pay the expense
          const initialBalance = await collective.getBalanceWithBlockedFunds();
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: totalAmountPaidInHostCurrency });
          expect(await collective.getBalanceWithBlockedFunds()).to.equal(
            initialBalance + totalAmountPaidInHostCurrency,
          );
          emailSendMessageSpy.resetHistory();
          const mutationParams = {
            expenseId: expense.id,
            action: 'PAY',
            paymentParams: {
              paymentProcessorFeeInHostCurrency,
              totalAmountPaidInHostCurrency,
              forceManual: true,
            },
          };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          result.errors && console.error(result.errors);
          expect(result.errors).to.not.exist;
          expect(result.data.processExpense.status).to.eq('PAID');
          expect(await collective.getBalanceWithBlockedFunds()).to.equal(initialBalance);

          // Check transactions
          const expenseTransactions = await models.Transaction.findAll({
            where: { ExpenseId: expense.id },
            order: [['id', 'DESC']],
          });

          await preloadAssociationsForTransactions(expenseTransactions, SNAPSHOT_COLUMNS);
          snapshotTransactions(expenseTransactions, { columns: SNAPSHOT_COLUMNS });

          const expenseAmountInCollectiveCurrency = totalAmountPaidInHostCurrency - paymentProcessorFeeInHostCurrency;

          const debitTransaction = expenseTransactions.find(({ type }) => type === 'DEBIT');
          expect(debitTransaction.currency).to.equal(collective.currency);
          expect(debitTransaction.hostCurrency).to.equal(host.currency); // same as collective.currency
          expect(debitTransaction.amount).to.equal(-expenseAmountInCollectiveCurrency);
          expect(debitTransaction.paymentProcessorFeeInHostCurrency).to.equal(-paymentProcessorFeeInHostCurrency);
          expect(debitTransaction.hostCurrencyFxRate).to.equal(1); // host & collective have the same currency
          expect(debitTransaction.netAmountInCollectiveCurrency).to.equal(
            -expenseAmountInCollectiveCurrency - paymentProcessorFeeInHostCurrency,
          );

          const hostCurrencyFxRate = 1.1;
          const creditTransaction = expenseTransactions.find(({ type }) => type === 'CREDIT');
          const paymentProcessorFeeInPayeeCurrency = Math.round(hostCurrencyFxRate * paymentProcessorFeeInHostCurrency);
          expect(creditTransaction.currency).to.equal(collective.currency);
          expect(creditTransaction.hostCurrency).to.equal(payee.host.currency);
          expect(creditTransaction.hostCurrencyFxRate).to.equal(hostCurrencyFxRate);
          expect(creditTransaction.amount).to.equal(
            expenseAmountInCollectiveCurrency + paymentProcessorFeeInHostCurrency,
          );
          expect(creditTransaction.netAmountInCollectiveCurrency).to.equal(expenseAmountInCollectiveCurrency);
          expect(creditTransaction.paymentProcessorFeeInHostCurrency).to.equal(-paymentProcessorFeeInPayeeCurrency);

          // Check sent emails
          await waitForCondition(() => emailSendMessageSpy.callCount === 2);
          expect(emailSendMessageSpy.callCount).to.equal(2);
          // Email to payee
          expect(emailSendMessageSpy.args[0][0]).to.equal(expense.User.email);
          expect(emailSendMessageSpy.args[0][1]).to.contain('R$100.00'); // title
          expect(emailSendMessageSpy.args[0][2]).to.contain(`has been paid`); // content
          expect(emailSendMessageSpy.args[0][2]).to.contain('R$100.00');
          // Email to collective
          expect(emailSendMessageSpy.args[1][0]).to.equal(hostAdmin.email);
          expect(emailSendMessageSpy.args[1][1]).to.contain(`Expense paid for ${collective.name}`);
        });
      });

      describe('Taxes', () => {
        it('with VAT', async () => {
          const collective = await fakeCollective({
            currency: 'EUR',
            settings: { VAT: { type: 'OWN', idNumber: 'XXXXXX' } },
            HostCollectiveId: host.id,
          });
          const payoutMethod = await fakePayoutMethod({ type: 'OTHER' });
          const expense = await fakeExpense({
            type: expenseTypes.INVOICE,
            amount: 100e2,
            CollectiveId: collective.id,
            status: 'APPROVED',
            currency: 'EUR',
            PayoutMethodId: payoutMethod.id,
          });

          // Add VAT to expense
          const rate = 0.2; // 20%
          await expense.update({
            amount: expense.amount * (1 + rate), // 120e2
            data: { taxes: [{ id: 'VAT', type: 'VAT', rate }] },
          });

          // Updates the collective balance and pay the expense
          await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 1000e2 });
          const mutationParams = { expenseId: expense.id, action: 'PAY' };
          const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
          result.errors && console.error(result.errors);
          const resultExpense = result.data.processExpense;
          expect(resultExpense.status).to.eq('PAID');

          // Check transactions
          const transactions = await expense.getTransactions();
          await Promise.all(transactions, t => t.validate());
          const credit = transactions.find(({ type }) => type === 'CREDIT');
          const debit = transactions.find(({ type }) => type === 'DEBIT');
          expect(debit.amount).to.equal(-expense.amount); // Full amount in collective currency
          expect(debit.netAmountInCollectiveCurrency).to.equal(-expense.amount);
          expect(debit.amountInHostCurrency).to.equal(-13200); // expense amount converted to USD
          expect(debit.taxAmount).to.equal(-2000); // In collective currency
          expect(debit.data.tax.type).to.eq('VAT');
          expect(debit.data.tax.rate).to.eq(0.2);
          expect(credit.amount).to.equal(expense.amount);
          expect(credit.taxAmount).to.equal(-2000);
          expect(debit.netAmountInCollectiveCurrency).to.equal(-expense.amount);
          expect(debit.amountInHostCurrency).to.equal(-13200);
          expect(credit.data.tax.type).to.eq('VAT');
          expect(credit.data.tax.rate).to.eq(0.2);
        });
      });
    });

    describe('MARK_AS_UNPAID', () => {
      it('Needs to be authenticated', async () => {
        const expense = await fakeExpense({ CollectiveId: collective.id, status: 'PAID' });
        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
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
        await payExpense(makeRequest(hostAdmin), {
          id: expense.id,
          forceManual: true,
          totalAmountPaidInHostCurrency: 1000,
        });
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(0);

        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(expense.amount);
        await payExpense(makeRequest(hostAdmin), {
          id: expense.id,
          forceManual: true,
          totalAmountPaidInHostCurrency: 1000,
        });
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(0);
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
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(0);

        const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
        const result = await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);
        expect(result.data.processExpense.status).to.eq('APPROVED');
        expect(await testCollective.getBalanceWithBlockedFunds()).to.eq(expense.amount);
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
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
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

    it('sets the PayoutMethodId on transactions correctly after editing the expense', async () => {
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

      const mutationParams = { expenseId: expense.id, action: 'MARK_AS_UNPAID' };
      await graphqlQueryV2(processExpenseMutation, mutationParams, hostAdmin);

      const originalTransactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
      expect(originalTransactions.every(tx => tx.PayoutMethodId === payoutMethod.id)).to.equal(true);

      const newPayoutMethod = await fakePayoutMethod({ type: 'OTHER' });
      await expense.update({ PayoutMethodId: newPayoutMethod.id });

      await fakeTransaction({ type: 'CREDIT', CollectiveId: testCollective.id, amount: expense.amount });
      await payExpense(makeRequest(hostAdmin), { id: expense.id });

      const newTransactions = await models.Transaction.findAll({
        where: { ExpenseId: expense.id },
        order: [['id', 'ASC']],
      });
      expect(newTransactions.slice(-2).every(tx => tx.PayoutMethodId === newPayoutMethod.id)).to.equal(true);
    });
  });

  describe('processExpense > PAY > with 2FA payouts', () => {
    const fee = 1.74;
    let collective,
      host,
      collectiveAdmin,
      hostAdmin,
      sandbox,
      expense1,
      expense2,
      expense3,
      expense4,
      user,
      payoutMethod;
    const quote = {
      payOut: 'BANK_TRANSFER',
      paymentOptions: [
        {
          payInProduct: 'BALANCE',
          fee: { total: fee },
          payIn: 'BALANCE',
          sourceCurrency: 'USD',
          targetCurrency: 'EUR',
          payOut: 'BANK_TRANSFER',
          disabled: false,
        },
      ],
    };

    before(() => {
      sandbox = createSandbox();
      sandbox.stub(paymentProviders.transferwise, 'payExpense').resolves({ quote });
      sandbox.stub(paymentProviders.transferwise, 'getTemporaryQuote').resolves(quote);
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
      payoutMethod = await fakePayoutMethod({
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
      };
      const result1 = await graphqlQueryV2(processExpenseMutation, expenseMutationParams1, hostAdmin, null, {
        [TwoFactorAuthenticationHeader]: `totp ${twoFactorAuthenticatorCode}`,
      });

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
      expect(result4.errors[0].message).to.eq('Two-factor authentication required');
      expect(result4.errors[0].extensions.code).to.eq('2FA_REQUIRED');
    });

    it('authorizes users based on their active session', async () => {
      const [expense1, expense2] = await multiple(fakeExpense, 2, {
        payoutMethod: 'transferwise',
        status: expenseStatus.APPROVED,
        amount: 10000,
        CollectiveId: collective.id,
        UserId: user.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
      });

      const secret = speakeasy.generateSecret({ length: 64 });
      const encryptedToken = crypto[CIPHER].encrypt(secret.base32, SECRET_KEY).toString();
      await hostAdmin.update({ twoFactorAuthToken: encryptedToken });
      const twoFactorAuthenticatorCode = speakeasy.totp({
        algorithm: 'SHA1',
        encoding: 'base32',
        secret: secret.base32,
      });

      // Fails the first time with session 1
      const result1 = await graphqlQueryV2(
        processExpenseMutation,
        {
          expenseId: expense1.id,
          action: 'PAY',
        },
        hostAdmin,
        {
          sessionId: '1',
        },
      );
      expect(result1.errors).to.exist;
      expect(result1.errors[0].message).to.eq('Two-factor authentication required');
      expect(result1.errors[0].extensions.code).to.eq('2FA_REQUIRED');

      // It works with session 1
      const result2 = await graphqlQueryV2(
        processExpenseMutation,
        {
          expenseId: expense1.id,
          action: 'PAY',
        },
        hostAdmin,
        null,
        {
          [TwoFactorAuthenticationHeader]: `totp ${twoFactorAuthenticatorCode}`,
        },
      );
      expect(result2.errors).to.not.exist;
      expect(result2.data.processExpense.status).to.eq('PROCESSING');

      // It fails with session 2
      const result3 = await graphqlQueryV2(
        processExpenseMutation,
        {
          expenseId: expense2.id,
          action: 'PAY',
        },
        hostAdmin,
        {
          sessionId: '2',
        },
      );
      expect(result3.errors).to.exist;
      expect(result3.errors[0].message).to.eq('Two-factor authentication required');
      expect(result3.errors[0].extensions.code).to.eq('2FA_REQUIRED');
    });
  });

  describe('draftExpenseAndInviteUser and resendDraftExpenseInvite', () => {
    let sandbox, collective, expense, user;

    const draftExpenseAndInviteUserMutation = gqlV2/* GraphQL */ `
      mutation DraftExpenseAndInviteUser($expense: ExpenseInviteDraftInput!, $account: AccountReferenceInput!) {
        draftExpenseAndInviteUser(expense: $expense, account: $account) {
          id
          legacyId
          status
          draft
        }
      }
    `;
    const resendDraftExpenseInviteMutation = gqlV2/* GraphQL */ `
      mutation ResendDraftExpenseInviteMutation($expense: ExpenseReferenceInput!) {
        resendDraftExpenseInvite(expense: $expense) {
          id
          legacyId
          status
          draft
        }
      }
    `;

    const invoice = {
      description: 'A valid expense',
      type: 'INVOICE',
      recipientNote: 'Hey pal, could you please submit this',
      payee: { name: 'John Doe', email: 'john@doe.co' },
      items: [
        {
          id: 'af89232d-7ac6-4e4f-9781-1c7d35fa76ca',
          url: '',
          amount: 4200,
          incurredAt: '2020-10-08',
          description: 'Goosebemps',
        },
      ],
      payeeLocation: { address: '123 Potatoes street', country: 'BE' },
    };

    after(() => sandbox.restore());

    before(async () => {
      sandbox = createSandbox();
      sandbox.stub(emailLib, 'sendMessage').resolves();
      user = await fakeUser();
      collective = await fakeCollective();

      const result = await graphqlQueryV2(
        draftExpenseAndInviteUserMutation,
        { expense: invoice, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.exist;
      expect(result.data.draftExpenseAndInviteUser).to.exist;

      const draftedExpense = result.data.draftExpenseAndInviteUser;
      expense = await models.Expense.findByPk(draftedExpense.legacyId);
    });

    it('should create a new DRAFT expense with a draftKey', async () => {
      expect(expense.status).to.eq(expenseStatus.DRAFT);
      expect(expense.amount).to.eq(4200);
      expect(expense.data.payeeLocation).to.deep.equal(invoice.payeeLocation);
      expect(expense.data.payee).to.deep.equal(invoice.payee);
      expect(expense.data.recipientNote).to.equal(invoice.recipientNote);
      expect(expense.data.draftKey).to.exist;
    });

    it('should send an email notifying the invited user to submit the expense', async () => {
      await waitForCondition(() => emailLib.sendMessage.firstCall);

      const [recipient, subject, body] = emailLib.sendMessage.firstCall.args;

      expect(recipient).to.eq(invoice.payee.email);
      expect(subject).to.include(collective.name);
      expect(subject).to.include('wants to pay you');
      expect(body).to.include(
        `href="http://localhost:3000/${collective.slug}/expenses/${expense.id}?key&#x3D;${expense.data.draftKey}"`,
      );
      expect(body).to.include('<td>Hey pal, could you please submit this</td>');
      expect(body).to.include('<td>Goosebemps</td>');
      expect(body).to.include('<td>$42.00</td>');
    });

    it('should resend the invite email', async () => {
      const result = await graphqlQueryV2(
        resendDraftExpenseInviteMutation,
        { expense: { legacyId: expense.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      await waitForCondition(() => emailLib.sendMessage.secondCall);

      const [recipient] = emailLib.sendMessage.secondCall.args;
      expect(recipient).to.eq(invoice.payee.email);
    });

    it('should invite an existing user', async () => {
      // Bypass RateLimit
      // sandbox.clock.tick(1000 * 10);
      const existingUser = await fakeUser();
      const expense = { ...invoice, payee: { id: existingUser.collective.id } };
      const result = await graphqlQueryV2(
        draftExpenseAndInviteUserMutation,
        { expense, account: { legacyId: collective.id } },
        user,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      await waitForCondition(() => emailLib.sendMessage.thirdCall);

      const [recipient] = emailLib.sendMessage.thirdCall.args;
      expect(recipient).to.eq(existingUser.email);
    });
  });
});
