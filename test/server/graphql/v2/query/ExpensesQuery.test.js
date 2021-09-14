import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { differenceBy } from 'lodash';

import { US_TAX_FORM_THRESHOLD } from '../../../../../server/constants/tax-form';
import models from '../../../../../server/models';
import { LEGAL_DOCUMENT_TYPE } from '../../../../../server/models/LegalDocument';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeLegalDocument,
  fakePayoutMethod,
  fakeTransaction,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const expensesQuery = gqlV2/* GraphQL */ `
  query Expenses(
    $fromAccount: AccountReferenceInput
    $account: AccountReferenceInput
    $host: AccountReferenceInput
    $status: ExpenseStatusFilter
  ) {
    expenses(fromAccount: $fromAccount, account: $account, host: $host, status: $status) {
      totalCount
      nodes {
        id
        legacyId
        status
        type
        description
        amount
      }
    }
  }
`;

/** Create a fake host */
const fakeHostWithRequiredLegalDocument = async (hostData = {}) => {
  const host = await fakeHost(hostData);
  const requiredDoc = { HostCollectiveId: host.id, documentType: 'US_TAX_FORM' };
  await models.RequiredLegalDocument.create(requiredDoc);
  return host;
};

describe('server/graphql/v2/query/ExpensesQuery', () => {
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

  describe('Ready to Pay filter', () => {
    let expensesReadyToPay, otherPayoutMethod, host;

    before(async () => {
      host = await fakeHostWithRequiredLegalDocument();
      otherPayoutMethod = await fakePayoutMethod({ type: 'OTHER' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const collectiveWithoutBalance = await fakeCollective({ HostCollectiveId: host.id });
      const baseExpenseData = {
        type: 'RECEIPT',
        CollectiveId: collective.id,
        status: 'APPROVED',
        amount: 1000,
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
      ]);

      await fakeLegalDocument({
        year: expensesReadyToPay[2].incurredAt.getFullYear(),
        CollectiveId: expensesReadyToPay[2].FromCollectiveId,
        requestStatus: 'RECEIVED',
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
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
      ]);

      // Add a tax form from last year on expense
      const expenseWithOutdatedTaxForm = expensesNotReadyToPay.find(({ description }) => description.includes('NRLY'));
      await fakeLegalDocument({
        year: expenseWithOutdatedTaxForm.incurredAt.getFullYear() - 4,
        CollectiveId: expenseWithOutdatedTaxForm.FromCollectiveId,
        requestStatus: 'RECEIVED',
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
      });
    });

    it('Only returns expenses that are ready to pay', async () => {
      const queryParams = { host: { legacyId: host.id }, status: 'READY_TO_PAY' };
      const result = await graphqlQueryV2(expensesQuery, queryParams);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.expenses.totalCount).to.eq(expensesReadyToPay.length);

      const missingExpenses = differenceBy(expensesReadyToPay, result.data.expenses.nodes, e => e.legacyId || e.id);
      if (missingExpenses.length) {
        throw new Error(`Missing expenses: ${missingExpenses.map(e => JSON.stringify(e.info))}`);
      }
    });
  });
});
