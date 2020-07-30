import { expect } from 'chai';
import { differenceBy } from 'lodash';

import { US_TAX_FORM_THRESHOLD } from '../../../../../server/constants/tax-form';
import models from '../../../../../server/models';
import { fakeCollective, fakeExpense, fakeHost, fakeTransaction } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const EXPENSES_QUERY = `
  query Expenses($fromAccount: AccountReferenceInput, $account: AccountReferenceInput, $host: AccountReferenceInput, $status: ExpenseStatusFilter) {
    expenses(fromAccount: $fromAccount, account: $account, host: $host, status: $status) {
      totalCount
      nodes {
        id
        legacyId
        status
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
      let result = await graphqlQueryV2(EXPENSES_QUERY, queryParams);
      expect(result.data.expenses.totalCount).to.eq(expenses.length);

      result = await graphqlQueryV2(EXPENSES_QUERY, { ...queryParams, status: 'ERROR' });
      expect(result.data.expenses.totalCount).to.eq(1);

      result = await graphqlQueryV2(EXPENSES_QUERY, { ...queryParams, status: 'REJECTED' });
      expect(result.data.expenses.totalCount).to.eq(1);
    });
  });

  describe('Ready to Pay filter', () => {
    let expensesReadyToPay, host;

    before(async () => {
      host = await fakeHostWithRequiredLegalDocument();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const collectiveWithoutBalance = await fakeCollective({ HostCollectiveId: host.id });
      const baseExpenseData = { type: 'RECEIPT', CollectiveId: collective.id, status: 'APPROVED', amount: 1000 };

      // Add balance to the collective
      await fakeTransaction({ type: 'CREDIT', CollectiveId: collective.id, amount: 1000000 });

      // Create expenses
      expensesReadyToPay = await Promise.all([
        fakeExpense({ ...baseExpenseData, type: 'RECEIPT' }),
        fakeExpense({ ...baseExpenseData, type: 'INVOICE' }),
      ]);

      await Promise.all([
        // Not ready to pay because of their status
        fakeExpense({ ...baseExpenseData, status: 'PENDING' }),
        fakeExpense({ ...baseExpenseData, status: 'REJECTED' }),
        fakeExpense({ ...baseExpenseData, status: 'PROCESSING' }),
        fakeExpense({ ...baseExpenseData, status: 'ERROR' }),
        fakeExpense({ ...baseExpenseData, status: 'PAID' }),
        fakeExpense({ ...baseExpenseData, status: 'SCHEDULED_FOR_PAYMENT' }),
        // Not ready to pay because of the balance
        fakeExpense({ ...baseExpenseData, CollectiveId: collectiveWithoutBalance.id }),
        // Not ready to pay because of the tax form
        fakeExpense({
          ...baseExpenseData,
          amount: US_TAX_FORM_THRESHOLD + 1,
          type: 'INVOICE',
          status: 'APPROVED',
        }),
      ]);
    });

    it('Only returns expenses that are ready to pay', async () => {
      const queryParams = { host: { legacyId: host.id }, status: 'READY_TO_PAY' };
      const result = await graphqlQueryV2(EXPENSES_QUERY, queryParams);
      expect(result.data.expenses.totalCount).to.eq(expensesReadyToPay.length);

      const missingExpenses = differenceBy(expensesReadyToPay, result.data.expenses.nodes, e => e.legacyId || e.id);
      if (missingExpenses.length) {
        throw new Error(`Missing expenses: ${missingExpenses.map(e => JSON.stringify(e.info))}`);
      }
    });
  });
});
