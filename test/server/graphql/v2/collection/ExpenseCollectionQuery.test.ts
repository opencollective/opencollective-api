import { expect } from 'chai';
import gql from 'fake-tag';
import { differenceBy, times } from 'lodash';
import moment from 'moment';
import { createSandbox } from 'sinon';

import ActivityTypes from '../../../../../server/constants/activities';
import {
  US_TAX_FORM_THRESHOLD_POST_2026,
  US_TAX_FORM_THRESHOLD_PRE_2026,
} from '../../../../../server/constants/tax-form';
import * as libcurrency from '../../../../../server/lib/currency';
import models from '../../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import {
  fakeActiveHost,
  fakeActivity,
  fakeCollective,
  fakeEvent,
  fakeExpense,
  fakeHost,
  fakeLegalDocument,
  fakePayoutMethod,
  fakeProject,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const US_TAX_FORM_THRESHOLD =
  moment().get('year') >= 2026 ? US_TAX_FORM_THRESHOLD_POST_2026 : US_TAX_FORM_THRESHOLD_PRE_2026;

const expensesQuery = gql`
  query Expenses(
    $fromAccount: AccountReferenceInput
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $status: [ExpenseStatusFilter]
    $searchTerm: String
    $customData: JSON
    $chargeHasReceipts: Boolean
    $includeChildrenExpenses: Boolean = false
    $activity: ExpenseActivityFilter
  ) {
    expenses(
      fromAccount: $fromAccount
      account: $account
      host: $host
      status: $status
      searchTerm: $searchTerm
      customData: $customData
      chargeHasReceipts: $chargeHasReceipts
      includeChildrenExpenses: $includeChildrenExpenses
      activity: $activity
    ) {
      totalCount
      totalAmount {
        amountsByCurrency {
          valueInCents
          currency
        }
        amount(currency: USD) {
          valueInCents
          currency
        }
      }
      nodes {
        id
        legacyId
        status
        type
        amount
        description
        tags
        payee {
          name
          slug
        }
      }
    }
  }
`;

/** Create a fake host */
const fakeHostWithRequiredLegalDocument = async (hostData = {}) => {
  const host = await fakeHost(hostData);
  await models.RequiredLegalDocument.create({
    HostCollectiveId: host.id,
    documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
  });
  return host;
};

describe('server/graphql/v2/collection/ExpenseCollection', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.stub(libcurrency, 'loadFxRatesMap').resolves({
      latest: {
        USD: { USD: 1 },
        GBP: { USD: 1.1 },
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('It aggregates total amount', async () => {
    const collective = await fakeCollective();
    const queryParams = { account: { legacyId: collective.id } };

    await fakeExpense({
      amount: 12000,
      currency: 'USD',
      type: 'RECEIPT',
      CollectiveId: collective.id,
      status: 'PENDING',
    });
    await fakeExpense({ amount: 5000, currency: 'GBP', type: 'RECEIPT', CollectiveId: collective.id, status: 'PAID' });
    await fakeExpense({
      amount: 5000,
      currency: 'GBP',
      type: 'RECEIPT',
      CollectiveId: collective.id,
      status: 'APPROVED',
    });

    const result = await graphqlQueryV2(expensesQuery, queryParams);
    expect(result.data.expenses.totalAmount.amountsByCurrency).to.have.deep.members([
      { valueInCents: 12000, currency: 'USD' },
      { valueInCents: 10000, currency: 'GBP' },
    ]);

    expect(result.data.expenses.totalAmount.amount).to.eql({ valueInCents: 23000, currency: 'USD' });
  });

  describe('Filter on basic status', () => {
    let expenses, collective;

    before(async () => {
      collective = await fakeCollective();
      expenses = await Promise.all([
        fakeExpense({ type: 'RECEIPT', CollectiveId: collective.id, status: 'PENDING' }),
        fakeExpense({ type: 'RECEIPT', CollectiveId: collective.id, status: 'APPROVED' }),
        fakeExpense({ type: 'RECEIPT', CollectiveId: collective.id, status: 'ERROR' }),
        fakeExpense({ type: 'RECEIPT', CollectiveId: collective.id, status: 'REJECTED' }),
        fakeExpense({ type: 'RECEIPT', CollectiveId: collective.id, status: 'PAID' }),
      ]);
    });

    it('Filter on basic statuses (PENDING, APPROVED...etc)', async () => {
      const queryParams = { account: { legacyId: collective.id } };

      // All status
      let result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.data.expenses.totalCount).to.eq(expenses.length);

      result = await graphqlQueryV2(expensesQuery, { ...queryParams, status: 'ERROR' });
      expect(result.data.expenses.totalCount).to.eq(1);

      result = await graphqlQueryV2(expensesQuery, { ...queryParams, status: 'REJECTED' });
      expect(result.data.expenses.totalCount).to.eq(1);
    });
  });

  describe('Filter by accounts', async () => {
    let expenses;

    const expenseQuery = gql`
      query Expenses(
        $createdByAccount: AccountReferenceInput
        $account: AccountReferenceInput
        $host: AccountReferenceInput
        $fromAccount: AccountReferenceInput
      ) {
        expenses(createdByAccount: $createdByAccount, account: $account, host: $host, fromAccount: $fromAccount) {
          nodes {
            id
            legacyId
            account {
              legacyId
            }
            payee {
              legacyId
            }
            createdByAccount {
              legacyId
            }
          }
        }
      }
    `;

    before(async () => {
      expenses = await Promise.all(times(3, () => fakeExpense()));
    });

    it('with createdByAccount', async () => {
      const result = await graphqlQueryV2(expenseQuery, {
        createdByAccount: { legacyId: expenses[0].fromCollective.id },
      });
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.nodes.length).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(expenses[0].id);
    });

    describe('with account', () => {
      describe('children expenses', () => {
        it('are not returned by default', async () => {
          const parentCollective = await fakeCollective();
          const childCollective = await fakeProject({ ParentCollectiveId: parentCollective.id });
          await fakeExpense({ type: 'RECEIPT', CollectiveId: childCollective.id, status: 'APPROVED' });
          const result = await graphqlQueryV2(expensesQuery, { account: { legacyId: parentCollective.id } });
          expect(result.data.expenses.totalCount).to.eq(0);
        });

        it('are returned if includeChildrenExpenses is true', async () => {
          const parentCollective = await fakeCollective();
          const childCollective = await fakeProject({ ParentCollectiveId: parentCollective.id });
          await fakeExpense({ type: 'RECEIPT', CollectiveId: childCollective.id, status: 'APPROVED' });
          const result = await graphqlQueryV2(expensesQuery, {
            account: { legacyId: parentCollective.id },
            includeChildrenExpenses: true,
          });
          expect(result.data.expenses.totalCount).to.eq(1);
        });
      });
    });

    describe('with fromAccount (payee)', () => {
      describe('children expenses', () => {
        it('are not returned by default', async () => {
          const parentCollective = await fakeCollective();
          const childCollective = await fakeProject({ ParentCollectiveId: parentCollective.id });
          await fakeExpense({ type: 'RECEIPT', FromCollectiveId: childCollective.id, status: 'APPROVED' });
          const result = await graphqlQueryV2(expensesQuery, { fromAccount: { legacyId: parentCollective.id } });
          expect(result.data.expenses.totalCount).to.eq(0);
        });

        it('are returned if includeChildrenExpenses is true', async () => {
          const parentCollective = await fakeCollective();
          const childCollective = await fakeProject({ ParentCollectiveId: parentCollective.id });
          await fakeExpense({ type: 'RECEIPT', FromCollectiveId: childCollective.id, status: 'APPROVED' });
          const result = await graphqlQueryV2(expensesQuery, {
            fromAccount: { legacyId: parentCollective.id },
            includeChildrenExpenses: true,
          });
          expect(result.data.expenses.totalCount).to.eq(1);
        });
      });
    });
  });

  describe('Filter by custom data', () => {
    it('Needs to be logged in', async () => {
      const result = await graphqlQueryV2(expensesQuery, { customData: { key: 'value' } });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('You need to be logged in to filter by customData');
    });

    it('Needs to filter by account, fromAccount or host', async () => {
      const user = await fakeUser();
      const result = await graphqlQueryV2(expensesQuery, { customData: { key: 'value' } }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq(
        'You need to filter by at least one of fromAccount, account or host to filter by customData',
      );
    });

    it('Needs to be an admin of account, fromAccount or host', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();
      const testAccount = async (accountKey: string) => {
        const args = { [accountKey]: { legacyId: collective.id }, customData: { key: 'value' } };
        const result = await graphqlQueryV2(expensesQuery, args, user);
        expect(result.errors, `Should not be allowed for ${accountKey}`).to.exist;
        expect(result.errors[0].message).to.eq(
          'You need to be an admin of the fromAccount, account or host to filter by customData',
        );
      };

      await testAccount('account');
      await testAccount('fromAccount');
      await testAccount('host');
    });

    it('Can filter using a simple field', async () => {
      const randomValue = randStr();
      await fakeExpense({ data: { customData: { myKey: 'anotherValue', anotherKey: 42 } } }); // To make sure it's not returned
      const expense = await fakeExpense({ data: { customData: { myKey: randomValue, anotherKey: 42 } } });
      const result = await graphqlQueryV2(
        expensesQuery,
        { fromAccount: { legacyId: expense.FromCollectiveId }, customData: { myKey: randomValue } },
        expense.User,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.nodes.length).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(expense.id);
    });

    it('Can filter using a nested value', async () => {
      const randomValue = randStr();
      await fakeExpense({ data: { customData: { myKey: 'anotherValue', anotherKey: 42 } } }); // To make sure it's not returned
      const expense = await fakeExpense({
        data: { customData: { myKey: { nestedKey: randomValue }, anotherKey: 42 } },
      });
      const result = await graphqlQueryV2(
        expensesQuery,
        { fromAccount: { legacyId: expense.FromCollectiveId }, customData: { myKey: { nestedKey: randomValue } } },
        expense.User,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.nodes.length).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(expense.id);
    });

    it('Payload needs to be a valid object', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      const testInvalidPayload = async payload => {
        const args = { fromAccount: { legacyId: collective.id }, customData: payload };
        const result = await graphqlQueryV2(expensesQuery, args, user);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('Expense custom data must be an object');
      };

      await testInvalidPayload('invalid');
      await testInvalidPayload(42);
      await testInvalidPayload(true);
    });

    it('Payload cannot be too large', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ admin: user });
      const payload = { key: 'a'.repeat(10001) };
      const args = { fromAccount: { legacyId: collective.id }, customData: payload };
      const result = await graphqlQueryV2(expensesQuery, args, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.eq('Expense custom data cannot exceed 10kB. Current size: 10.011kB');
    });
  });

  describe('Ready to Pay filter', () => {
    let expensesReadyToPay, otherPayoutMethod, host;

    before(async () => {
      host = await fakeHostWithRequiredLegalDocument();
      otherPayoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.OTHER });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const collectiveWithoutBalance = await fakeCollective({ HostCollectiveId: host.id });
      const baseExpenseData = {
        type: 'RECEIPT',
        CollectiveId: collective.id,
        status: 'APPROVED',
        amount: 1000,
        currency: 'USD',
        PayoutMethodId: otherPayoutMethod.id,
      };
      const expenseWithTaxFormData = {
        ...baseExpenseData,
        amount: US_TAX_FORM_THRESHOLD + 1,
        type: 'INVOICE',
        description: 'Not ready (tax form)',
      };

      // Add balance to the collective
      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 1000000 });

      // Create expenses
      expensesReadyToPay = await Promise.all([
        fakeExpense({ ...baseExpenseData, description: 'Ready (receipt)', type: 'RECEIPT' }),
        fakeExpense({ ...baseExpenseData, description: 'Ready (invoice)', type: 'INVOICE' }),
        fakeExpense({ ...expenseWithTaxFormData, description: 'Ready (invoice, submitted tax form)' }),
        fakeExpense({
          ...baseExpenseData,
          description: 'Ready (enough balance in different currency)',
          amount: 1000000,
          currency: 'SEK',
          type: 'INVOICE',
        }),
      ]);

      await fakeLegalDocument({
        year: expensesReadyToPay[2].incurredAt.getFullYear(),
        CollectiveId: expensesReadyToPay[2].FromCollectiveId,
        requestStatus: 'RECEIVED',
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
      });
      await fakeLegalDocument({
        year: expensesReadyToPay[3].incurredAt.getFullYear(),
        CollectiveId: expensesReadyToPay[3].FromCollectiveId,
        requestStatus: 'RECEIVED',
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
      });

      const expenseWithoutEnoughBalanceInDifferentCurrency = await fakeExpense({
        ...baseExpenseData,
        description: 'Ready (not enough balance in different currency)',
        amount: 800000,
        currency: 'GBP',
        type: 'INVOICE',
      });
      const expensesNotReadyToPay = await Promise.all([
        // Not ready to pay because of their status
        fakeExpense({ ...baseExpenseData, description: 'Not ready (status)', status: 'PENDING' }),
        fakeExpense({ ...baseExpenseData, description: 'Not ready (status)', status: 'REJECTED' }),
        fakeExpense({ ...baseExpenseData, description: 'Not ready (status)', status: 'PROCESSING' }),
        fakeExpense({ ...baseExpenseData, description: 'Not ready (status)', status: 'ERROR' }),
        fakeExpense({ ...baseExpenseData, description: 'Not ready (status)', status: 'PAID' }),
        fakeExpense({ ...baseExpenseData, description: 'Not ready (status)', status: 'SCHEDULED_FOR_PAYMENT' }),
        // Not ready to pay because of the balance
        fakeExpense({
          ...baseExpenseData,
          description: 'Not ready (balance)',
          CollectiveId: collectiveWithoutBalance.id,
        }),
        // Not ready to pay because of the tax form
        // -- No tax form submitted
        fakeExpense({ ...expenseWithTaxFormData }),
        // Tax form submitted last year
        fakeExpense({ ...expenseWithTaxFormData, description: 'Not ready (tax form submitted for last year) [NRLY]' }),
        expenseWithoutEnoughBalanceInDifferentCurrency,
      ]);

      // Add a tax form from last year on expense
      const expenseWithOutdatedTaxForm = expensesNotReadyToPay.find(({ description }) => description.includes('NRLY'));
      await fakeLegalDocument({
        year: expenseWithOutdatedTaxForm.incurredAt.getFullYear() - 4,
        CollectiveId: expenseWithOutdatedTaxForm.FromCollectiveId,
        requestStatus: 'RECEIVED',
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
      });
      // Make sure the last expense is not failing due to missing tax file
      await fakeLegalDocument({
        year: expenseWithoutEnoughBalanceInDifferentCurrency.incurredAt.getFullYear(),
        CollectiveId: expenseWithoutEnoughBalanceInDifferentCurrency.FromCollectiveId,
        requestStatus: 'RECEIVED',
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
      });

      await models.LegalDocument.expireOldDocuments();
    });

    beforeEach(() => {
      sandbox.restore();
      sandbox.stub(libcurrency, 'loadFxRatesMap').resolves({
        latest: {
          USD: { USD: 1 },
          SEK: { USD: 0.09 },
          GBP: { USD: 1.5 },
        },
      });
    });

    it('Only returns expenses that are ready to pay', async () => {
      const queryParams = { host: { legacyId: host.id }, status: 'READY_TO_PAY' };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.totalCount).to.eq(expensesReadyToPay.length);

      const missingExpenses = differenceBy(
        expensesReadyToPay,
        result.data.expenses.nodes,
        e => e['legacyId'] || e['id'],
      );
      if (missingExpenses.length) {
        throw new Error(`Missing expenses: ${missingExpenses.map(e => JSON.stringify(e['info']))}`);
      }
    });

    it('Includes v3 collective expenses when v2 balance would be insufficient', async () => {
      // Collective on budget v3: v3 excludes HostCollectiveId=null transactions, v2 includes all
      // Add DEBIT with HostCollectiveId=null to reduce v2 balance but not v3
      // Result: v2 balance = $200, v3 balance = $1000. Expense $500 would fail with v2, pass with v3
      const v3Collective = await fakeCollective({
        HostCollectiveId: host.id,
        currency: 'USD',
        settings: { budget: { version: 'v3' } },
      });
      const fromCollective = await fakeCollective();
      await fakeTransaction(
        {
          type: 'CREDIT',
          CollectiveId: v3Collective.id,
          FromCollectiveId: fromCollective.id,
          HostCollectiveId: host.id,
          amount: 100000,
          netAmountInCollectiveCurrency: 100000,
          amountInHostCurrency: 100000,
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          type: 'DEBIT',
          amount: -80000,
          CollectiveId: v3Collective.id,
          FromCollectiveId: fromCollective.id,
          HostCollectiveId: null,
          netAmountInCollectiveCurrency: -80000,
          amountInHostCurrency: -80000,
          hostCurrency: 'USD',
        },
        { createDoubleEntry: true },
      );
      const v3Expense = await fakeExpense({
        CollectiveId: v3Collective.id,
        type: 'RECEIPT',
        status: 'APPROVED',
        amount: 50000,
        currency: 'USD',
        PayoutMethodId: otherPayoutMethod.id,
        description: 'Ready (v3 collective, sufficient v3 balance)',
      });
      const queryParams = { host: { legacyId: host.id }, status: 'READY_TO_PAY' };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const readyExpenseIds = result.data.expenses.nodes.map(e => e.legacyId || e.id);
      expect(readyExpenseIds).to.include(v3Expense.id);
    });
  });

  describe('Activity filter', () => {
    let user1, user2, user3, expenseCreator, collective, expense1, expense2, expense3, expense4, expense5;

    before(async () => {
      user1 = await fakeUser();
      user2 = await fakeUser();
      user3 = await fakeUser();
      expenseCreator = await fakeUser();
      collective = await fakeCollective();

      expense1 = await fakeExpense({ CollectiveId: collective.id, UserId: expenseCreator.id, status: 'PENDING' });
      expense2 = await fakeExpense({ CollectiveId: collective.id, UserId: expenseCreator.id, status: 'PENDING' });
      expense3 = await fakeExpense({ CollectiveId: collective.id, UserId: expenseCreator.id, status: 'PENDING' });
      expense4 = await fakeExpense({ CollectiveId: collective.id, UserId: expenseCreator.id, status: 'PENDING' });
      expense5 = await fakeExpense({ CollectiveId: collective.id, UserId: expenseCreator.id, status: 'PENDING' });

      // User1 interacts with expense1 (approved)
      await fakeActivity({
        ExpenseId: expense1.id,
        UserId: user1.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
      });

      // User1 interacts with expense2 (rejected)
      await fakeActivity({
        ExpenseId: expense2.id,
        UserId: user1.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
      });

      // User2 interacts with expense1 (updated)
      await fakeActivity({
        ExpenseId: expense1.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
      });

      // User2 interacts with expense3 (approved)
      await fakeActivity({
        ExpenseId: expense3.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
      });

      // User3 interacts with expense4 (approved)
      await fakeActivity({
        ExpenseId: expense4.id,
        UserId: user3.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
      });

      // Expense2: rejected by user1, then later approved by user2, then paid
      await fakeActivity({
        ExpenseId: expense2.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
      });
      await fakeActivity({
        ExpenseId: expense2.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_PAID,
      });

      // Expense5: rejected by user2
      await fakeActivity({
        ExpenseId: expense5.id,
        UserId: user2.id,
        type: ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
      });
    });

    it('Returns all expenses that user1 interacted with', async () => {
      const queryParams = {
        account: { legacyId: collective.id },
        activity: { individual: { legacyId: user1.collective.id } },
      };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.totalCount).to.eq(2);
      const expenseIds = result.data.expenses.nodes.map(e => e.legacyId);
      expect(expenseIds).to.include(expense1.id);
      expect(expenseIds).to.include(expense2.id);
      expect(expenseIds).to.not.include(expense3.id);
      expect(expenseIds).to.not.include(expense4.id);
      expect(expenseIds).to.not.include(expense5.id);
    });

    it('Returns all expenses that user2 interacted with', async () => {
      const queryParams = {
        account: { legacyId: collective.id },
        activity: { individual: { legacyId: user2.collective.id } },
      };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.errors).to.not.exist;
      // user2 should have interacted with: expense1 (updated), expense2 (approved+paid), expense3 (approved), expense5 (rejected)
      const expenseIds = result.data.expenses.nodes.map(e => e.legacyId);
      expect(expenseIds).to.include(expense1.id); // Updated by user2
      expect(expenseIds).to.include(expense2.id); // Approved and paid by user2
      expect(expenseIds).to.include(expense3.id); // Approved by user2
      expect(expenseIds).to.include(expense5.id); // Rejected by user2
      // Verify we get at least the 4 expected expenses
      // (may be more if there are auto-created activities we're not accounting for)
      expect(result.data.expenses.totalCount).to.be.at.least(4);
      // expense4 should NOT be included as it only has user3's approval
      expect(expenseIds).to.not.include(expense4.id);
    });

    it('Returns all expenses that have been rejected (even if later approved/paid)', async () => {
      const queryParams = {
        account: { legacyId: collective.id },
        activity: { type: ['COLLECTIVE_EXPENSE_REJECTED'] },
      };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.totalCount).to.eq(2);
      const expenseIds = result.data.expenses.nodes.map(e => e.legacyId);
      expect(expenseIds).to.include(expense2.id); // Rejected then approved/paid
      expect(expenseIds).to.include(expense5.id); // Rejected
      expect(expenseIds).to.not.include(expense1.id);
      expect(expenseIds).to.not.include(expense3.id);
      expect(expenseIds).to.not.include(expense4.id);
    });

    it('Returns all expenses approved by user2', async () => {
      const queryParams = {
        account: { legacyId: collective.id },
        activity: {
          individual: { legacyId: user2.collective.id },
          type: ['COLLECTIVE_EXPENSE_APPROVED'],
        },
      };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.totalCount).to.eq(2);
      const expenseIds = result.data.expenses.nodes.map(e => e.legacyId);
      expect(expenseIds).to.include(expense2.id);
      expect(expenseIds).to.include(expense3.id);
      expect(expenseIds).to.not.include(expense1.id);
      expect(expenseIds).to.not.include(expense4.id);
      expect(expenseIds).to.not.include(expense5.id);
    });

    it('Returns all expenses approved by user3', async () => {
      const queryParams = {
        account: { legacyId: collective.id },
        activity: {
          individual: { legacyId: user3.collective.id },
          type: ['COLLECTIVE_EXPENSE_APPROVED'],
        },
      };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.totalCount).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(expense4.id);
    });

    it('Returns expenses filtered by multiple activity types', async () => {
      const queryParams = {
        account: { legacyId: collective.id },
        activity: {
          type: ['COLLECTIVE_EXPENSE_APPROVED', 'COLLECTIVE_EXPENSE_REJECTED'],
        },
      };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.errors).to.not.exist;
      // Should include expenses with APPROVED or REJECTED activities:
      // expense1 (approved by user1), expense2 (rejected+approved), expense3 (approved), expense4 (approved), expense5 (rejected)
      const expenseIds = result.data.expenses.nodes.map(e => e.legacyId);
      expect(expenseIds).to.include(expense1.id); // Approved by user1
      expect(expenseIds).to.include(expense2.id); // Rejected by user1, approved by user2
      expect(expenseIds).to.include(expense3.id); // Approved by user2
      expect(expenseIds).to.include(expense4.id); // Approved by user3
      expect(expenseIds).to.include(expense5.id); // Rejected by user2
      // Verify we get at least the 5 expected expenses
      // (may be more if there are auto-created activities we're not accounting for)
      expect(result.data.expenses.totalCount).to.be.at.least(5);
    });

    describe('Error checks', () => {
      it('Throws error when individual account is not found', async () => {
        const queryParams = {
          account: { legacyId: collective.id },
          activity: { individual: { legacyId: 999999 } },
        };
        const result = await graphqlQueryV2(expensesQuery, queryParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.include('Account Not Found');
      });

      it('Throws error when individual account is not a user account', async () => {
        const nonUserCollective = await fakeCollective();
        const queryParams = {
          account: { legacyId: collective.id },
          activity: { individual: { legacyId: nonUserCollective.id } },
        };
        const result = await graphqlQueryV2(expensesQuery, queryParams);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.eq('User not found');
      });

      it('Throws error when activity type is invalid', async () => {
        const queryParams = {
          account: { legacyId: collective.id },
          activity: { type: ['INVALID_ACTIVITY_TYPE'] },
        };
        const result = await graphqlQueryV2(expensesQuery, queryParams);
        expect(result.errors).to.exist;
        // GraphQL validation error happens before resolver
        expect(result.errors[0].message).to.include('Variable "$activity" got invalid value');
      });

      it('Throws error when multiple invalid activity types are provided', async () => {
        const queryParams = {
          account: { legacyId: collective.id },
          activity: { type: ['INVALID_TYPE_1', 'INVALID_TYPE_2'] },
        };
        const result = await graphqlQueryV2(expensesQuery, queryParams);
        expect(result.errors).to.exist;
        // GraphQL validation error happens before resolver
        expect(result.errors[0].message).to.include('Variable "$activity" got invalid value');
      });

      it('Throws error when activity type is not an expense-related activity', async () => {
        const queryParams = {
          account: { legacyId: collective.id },
          activity: { type: ['COLLECTIVE_CREATED'] },
        };
        const result = await graphqlQueryV2(expensesQuery, queryParams);
        expect(result.errors).to.exist;
        // This should reach the resolver and throw the custom error
        expect(result.errors[0].message).to.include('Invalid activity type');
        expect(result.errors[0].message).to.include('collective.created');
      });
    });
  });

  describe('Search Expenses', () => {
    let hostAdminUser, ownerUser, expenseOne, expenseTwo;

    before(async () => {
      await resetTestDB();

      // Create data
      ownerUser = await fakeUser();
      hostAdminUser = await fakeUser();
      const collectiveAdminUser = await fakeUser();
      const host = await fakeCollective({ admin: hostAdminUser.collective });
      const collective = await fakeCollective({ admin: collectiveAdminUser.collective, HostCollectiveId: host.id });
      expenseOne = await fakeExpense({
        FromCollectiveId: ownerUser.collective.id,
        CollectiveId: collective.id,
        description: 'This is an expense by OpenCollective',
        tags: ['invoice', 'expense', 'opencollective'],
      });
      expenseTwo = await fakeExpense({
        FromCollectiveId: hostAdminUser.collective.id,
        CollectiveId: collective.id,
        description: 'This is another expense by engineering',
        tags: ['engineering', 'software', 'payout'],
      });
    });

    it('searches in description', async () => {
      const result = await graphqlQueryV2(expensesQuery, { searchTerm: 'OpenCollective' });
      expect(result.data.expenses.totalCount).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(expenseOne.id);
    });

    it('searches in tags', async () => {
      const result = await graphqlQueryV2(expensesQuery, { searchTerm: 'payout' });
      expect(result.data.expenses.totalCount).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(expenseTwo.id);
    });

    it('searches in payee name', async () => {
      const result = await graphqlQueryV2(expensesQuery, { searchTerm: ownerUser.collective.name });
      expect(result.data.expenses.totalCount).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(expenseOne.id);
    });

    it('searches in payee slug', async () => {
      const slug = hostAdminUser.collective.slug;
      const result = await graphqlQueryV2(expensesQuery, { searchTerm: slug });
      expect(result.data.expenses.totalCount).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(expenseTwo.id);
    });
  });

  describe('chargeHasReceipts', () => {
    it('Returns virtual card expenses with receipts', async () => {
      const collective = await fakeCollective();
      await fakeExpense({ type: 'INVOICE', CollectiveId: collective.id }); // random Expense
      const virtualCardWithReceipt = await fakeExpense({
        type: 'CHARGE',
        CollectiveId: collective.id,
        items: [{ description: 'item 1', amount: 1000, currency: 'USD', url: 'http://example.com' }],
      });

      await fakeExpense({
        type: 'CHARGE',
        CollectiveId: collective.id,
        items: [
          {
            description: 'item 1',
            amount: 1000,
            currency: 'USD',
            url: null,
          },
        ],
      });

      const queryParams = { account: { legacyId: collective.id }, chargeHasReceipts: true };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.totalCount).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(virtualCardWithReceipt.id);
    });

    it('Returns virtual card expenses without receipts', async () => {
      const collective = await fakeCollective();
      await fakeExpense({ type: 'INVOICE', CollectiveId: collective.id }); // random Expense
      const virtualCardWithoutReceipt = await fakeExpense({
        type: 'CHARGE',
        CollectiveId: collective.id,
        items: [{ description: 'item 1', amount: 1000, currency: 'USD', url: null }],
      });

      await fakeExpense({
        type: 'CHARGE',
        CollectiveId: collective.id,
        items: [
          {
            description: 'item 1',
            amount: 1000,
            currency: 'USD',
            url: 'http://example.com',
          },
        ],
      });

      const queryParams = { account: { legacyId: collective.id }, chargeHasReceipts: false };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.totalCount).to.eq(1);
      expect(result.data.expenses.nodes[0].legacyId).to.eq(virtualCardWithoutReceipt.id);
    });
  });

  describe('hostContext filter', () => {
    const expensesWithHostContextQuery = gql`
      query ExpensesWithHostContext(
        $host: AccountReferenceInput
        $hostContext: HostContext
        $account: AccountReferenceInput
      ) {
        expenses(host: $host, hostContext: $hostContext, account: $account) {
          totalCount
          nodes {
            id
            legacyId
            account {
              legacyId
              slug
            }
          }
        }
      }
    `;

    let host,
      hostChild,
      hostedCollective,
      hostedCollectiveChild,
      expenseOnHost,
      expenseOnHostChild,
      expenseOnHostedCollective,
      expenseOnHostedCollectiveChild;

    before(async () => {
      // Create a host account with money management
      host = await fakeActiveHost();

      // Create a child account (event) directly under the host
      hostChild = await fakeEvent({
        ParentCollectiveId: host.id,
        HostCollectiveId: host.id,
        approvedAt: new Date(),
      });

      // Create a hosted collective (not a child of host)
      hostedCollective = await fakeCollective({
        HostCollectiveId: host.id,
        approvedAt: new Date(),
      });

      // Create a child account under the hosted collective
      hostedCollectiveChild = await fakeProject({
        ParentCollectiveId: hostedCollective.id,
        HostCollectiveId: host.id,
        approvedAt: new Date(),
      });

      // Create expenses for each account
      expenseOnHost = await fakeExpense({
        CollectiveId: host.id,
        status: 'APPROVED',
        description: 'Expense on host',
      });

      expenseOnHostChild = await fakeExpense({
        CollectiveId: hostChild.id,
        status: 'APPROVED',
        description: 'Expense on host child',
      });

      expenseOnHostedCollective = await fakeExpense({
        CollectiveId: hostedCollective.id,
        status: 'APPROVED',
        description: 'Expense on hosted collective',
      });

      expenseOnHostedCollectiveChild = await fakeExpense({
        CollectiveId: hostedCollectiveChild.id,
        status: 'APPROVED',
        description: 'Expense on hosted collective child',
      });
    });

    it('should return all expenses when hostContext is ALL', async () => {
      const result = await graphqlQueryV2(expensesWithHostContextQuery, {
        host: { legacyId: host.id },
        hostContext: 'ALL',
      });

      expect(result.errors).to.not.exist;
      // Verify all expected expenses are included
      const expenseIds = result.data.expenses.nodes.map(node => node.legacyId);
      expect(expenseIds).to.include(expenseOnHost.id);
      expect(expenseIds).to.include(expenseOnHostChild.id);
      expect(expenseIds).to.include(expenseOnHostedCollective.id);
      expect(expenseIds).to.include(expenseOnHostedCollectiveChild.id);
    });

    it('should return only expenses from host and its children when hostContext is INTERNAL', async () => {
      const result = await graphqlQueryV2(expensesWithHostContextQuery, {
        host: { legacyId: host.id },
        hostContext: 'INTERNAL',
      });

      expect(result.errors).to.not.exist;
      // Verify host/internal expenses ARE included
      const expenseIds = result.data.expenses.nodes.map(node => node.legacyId);
      expect(expenseIds).to.include(expenseOnHost.id);
      expect(expenseIds).to.include(expenseOnHostChild.id);
      // Verify hosted collective expenses are NOT included
      expect(expenseIds).to.not.include(expenseOnHostedCollective.id);
      expect(expenseIds).to.not.include(expenseOnHostedCollectiveChild.id);
    });

    it('should return only expenses from hosted accounts (excluding host) when hostContext is HOSTED', async () => {
      const result = await graphqlQueryV2(expensesWithHostContextQuery, {
        host: { legacyId: host.id },
        hostContext: 'HOSTED',
      });

      expect(result.errors).to.not.exist;
      // Verify hosted collective expenses ARE included
      const expenseIds = result.data.expenses.nodes.map(node => node.legacyId);
      expect(expenseIds).to.include(expenseOnHostedCollective.id);
      expect(expenseIds).to.include(expenseOnHostedCollectiveChild.id);
      // Verify host/internal expenses are NOT included
      expect(expenseIds).to.not.include(expenseOnHost.id);
      expect(expenseIds).to.not.include(expenseOnHostChild.id);
    });

    it('should return all host expenses when hostContext is not set (default behavior)', async () => {
      const result = await graphqlQueryV2(expensesWithHostContextQuery, {
        host: { legacyId: host.id },
      });

      expect(result.errors).to.not.exist;
      // Verify all expected expenses are included
      const expenseIds = result.data.expenses.nodes.map(node => node.legacyId);
      expect(expenseIds).to.include(expenseOnHost.id);
      expect(expenseIds).to.include(expenseOnHostChild.id);
      expect(expenseIds).to.include(expenseOnHostedCollective.id);
      expect(expenseIds).to.include(expenseOnHostedCollectiveChild.id);
    });

    describe('edge cases', () => {
      it('should include paid expenses where HostCollectiveId is set directly on expense', async () => {
        // When an expense is paid, HostCollectiveId is set directly on the expense
        const paidExpenseOnHostedCollective = await fakeExpense({
          CollectiveId: hostedCollective.id,
          HostCollectiveId: host.id,
          status: 'PAID',
          description: 'Paid expense on hosted collective',
        });

        const result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'HOSTED',
        });

        expect(result.errors).to.not.exist;
        const expenseIds = result.data.expenses.nodes.map(node => node.legacyId);
        expect(expenseIds).to.include(paidExpenseOnHostedCollective.id);

        // Cleanup
        await paidExpenseOnHostedCollective.destroy();
      });

      it('should NOT include expenses from unapproved hosted collectives', async () => {
        // Create an unapproved collective
        const unapprovedCollective = await fakeCollective({
          HostCollectiveId: host.id,
          approvedAt: null,
        });
        const expenseOnUnapproved = await fakeExpense({
          CollectiveId: unapprovedCollective.id,
          status: 'APPROVED',
          description: 'Expense on unapproved collective',
        });

        const result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'ALL',
        });

        expect(result.errors).to.not.exist;
        const expenseIds = result.data.expenses.nodes.map(node => node.legacyId);
        // Unapproved collective's expenses should NOT be included
        expect(expenseIds).to.not.include(expenseOnUnapproved.id);

        // Cleanup
        await expenseOnUnapproved.destroy();
        await unapprovedCollective.destroy();
      });
    });

    describe('combining host, account, and hostContext', () => {
      it('should return expenses for specific hosted account when combined with hostContext HOSTED', async () => {
        const result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'HOSTED',
          account: { legacyId: hostedCollective.id },
        });

        expect(result.errors).to.not.exist;
        expect(result.data.expenses.totalCount).to.eq(1);
        expect(result.data.expenses.nodes[0].legacyId).to.eq(expenseOnHostedCollective.id);
      });

      it('should return expenses for host account when combined with hostContext INTERNAL', async () => {
        const result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'INTERNAL',
          account: { legacyId: host.id },
        });

        expect(result.errors).to.not.exist;
        expect(result.data.expenses.totalCount).to.eq(1);
        expect(result.data.expenses.nodes[0].legacyId).to.eq(expenseOnHost.id);
      });

      it('should return expenses for host child account when combined with hostContext INTERNAL', async () => {
        const result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'INTERNAL',
          account: { legacyId: hostChild.id },
        });

        expect(result.errors).to.not.exist;
        expect(result.data.expenses.totalCount).to.eq(1);
        expect(result.data.expenses.nodes[0].legacyId).to.eq(expenseOnHostChild.id);
      });

      it('should throw error when account is a hosted collective but hostContext is INTERNAL', async () => {
        const result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'INTERNAL',
          account: { legacyId: hostedCollective.id },
        });

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.include(
          'When hostContext is INTERNAL, accounts must be the host account or its children',
        );
      });

      it('should throw error when account is the host but hostContext is HOSTED', async () => {
        const result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'HOSTED',
          account: { legacyId: host.id },
        });

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.include(
          'When hostContext is HOSTED, accounts cannot be the host account or its direct children',
        );
      });

      it('should throw error when account is a host child but hostContext is HOSTED', async () => {
        const result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'HOSTED',
          account: { legacyId: hostChild.id },
        });

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.include(
          'When hostContext is HOSTED, accounts cannot be the host account or its direct children',
        );
      });

      it('should allow any hosted account when hostContext is ALL', async () => {
        // Test with host account
        let result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'ALL',
          account: { legacyId: host.id },
        });
        expect(result.errors).to.not.exist;
        expect(result.data.expenses.totalCount).to.eq(1);

        // Test with hosted collective
        result = await graphqlQueryV2(expensesWithHostContextQuery, {
          host: { legacyId: host.id },
          hostContext: 'ALL',
          account: { legacyId: hostedCollective.id },
        });
        expect(result.errors).to.not.exist;
        expect(result.data.expenses.totalCount).to.eq(1);
      });
    });
  });
});
