import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { differenceBy, times } from 'lodash';
import { createSandbox } from 'sinon';

import { US_TAX_FORM_THRESHOLD } from '../../../../../server/constants/tax-form';
import * as libcurrency from '../../../../../server/lib/currency';
import models from '../../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../../server/models/LegalDocument';
import { PayoutMethodTypes } from '../../../../../server/models/PayoutMethod';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeLegalDocument,
  fakePayoutMethod,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const expensesQuery = gqlV2/* GraphQL */ `
  query Expenses(
    $fromAccount: AccountReferenceInput
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $status: ExpenseStatusFilter
    $searchTerm: String
    $customData: JSON
  ) {
    expenses(
      fromAccount: $fromAccount
      account: $account
      host: $host
      status: $status
      searchTerm: $searchTerm
      customData: $customData
    ) {
      totalCount
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
  await models.RequiredLegalDocument.create({ HostCollectiveId: host.id, documentType: 'US_TAX_FORM' });
  return host;
};

describe('server/graphql/v2/collection/ExpenseCollection', () => {
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

    const expenseQuery = gqlV2/* GraphQL */ `
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
        expect(result.errors).to.exist;
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
    let expensesReadyToPay, otherPayoutMethod, host, sandbox;

    before(async () => {
      sandbox = createSandbox();
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

      sandbox
        .stub(libcurrency, 'getFxRates')
        .withArgs('SEK', ['USD'])
        .resolves({ USD: 0.09 })
        .withArgs('GBP', ['USD'])
        .resolves({ USD: 1.5 })
        .withArgs('USD', ['USD'])
        .resolves({ USD: 1 });

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
    });

    after(() => {
      sandbox.restore();
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
});
