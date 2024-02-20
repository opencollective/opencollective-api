import { expect } from 'chai';
import config from 'config';

import { roles } from '../../../../../server/constants';
import { createRefundTransaction } from '../../../../../server/lib/payments';
import { createTransactionsFromPaidExpense } from '../../../../../server/lib/transactions';
import models from '../../../../../server/models';
import { fakeExpense, fakeTransaction, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB, seedDefaultVendors } from '../../../../utils';

describe('Transaction', () => {
  let expense, hostAdmin;
  const originalSeparatePaymentProcessorFees = config.ledger.separatePaymentProcessorFees;

  before(async () => {
    config.ledger.separatePaymentProcessorFees = true;
    await resetTestDB({ groupedTruncate: false });
    await seedDefaultVendors();
  });
  after(() => {
    config.ledger.separatePaymentProcessorFees = originalSeparatePaymentProcessorFees;
  });

  beforeEach(async () => {
    hostAdmin = await fakeUser();
    expense = await fakeExpense({ amount: 10000, status: 'PAID' });
    await expense.collective.host.addUserWithRole(hostAdmin, roles.ADMIN);

    await createTransactionsFromPaidExpense(
      expense.collective.host,
      expense,
      {
        hostFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: -390,
      },
      1,
    );

    const transaction = await models.Transaction.findOne({
      where: {
        ExpenseId: expense.id,
        RefundTransactionId: null,
        kind: 'EXPENSE',
        isRefund: false,
      },
      include: [{ model: models.Expense }],
    });
    await createRefundTransaction(transaction, 390, null, hostAdmin);
  });

  it('should fetch the correct payment processor fee', async () => {
    const query = `
      query Transactions($legacyExpenseId: Int!) {
        transactions(expense: { legacyId: $legacyExpenseId }) {
          nodes {
            id
            type
            kind
            isRefund
            fromAccount {
              slug
            }
            toAccount {
              slug
            }
            amountInHostCurrency {
              valueInCents
              currency
            }
            netAmountInHostCurrency(fetchPaymentProcessorFee: true) {
              valueInCents
              currency
            }
            paymentProcessorFee(fetchPaymentProcessorFee: true) {
              valueInCents
              currency
            }
          }
        }
      }
    `;

    const result = await graphqlQueryV2(query, { legacyExpenseId: expense.id }, hostAdmin);
    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.transactions.nodes).to.containSubset([
      // Original Transactions
      {
        kind: 'PAYMENT_PROCESSOR_FEE',
        type: 'CREDIT',
        amountInHostCurrency: { valueInCents: 390 },
        netAmountInHostCurrency: { valueInCents: 390 },
        paymentProcessorFee: { valueInCents: 0 },
        isRefund: false,
      },
      {
        kind: 'PAYMENT_PROCESSOR_FEE',
        type: 'DEBIT',
        amountInHostCurrency: { valueInCents: -390 },
        netAmountInHostCurrency: { valueInCents: -390 },
        paymentProcessorFee: { valueInCents: 0 },
        isRefund: false,
      },
      {
        kind: 'EXPENSE',
        type: 'CREDIT',
        amountInHostCurrency: { valueInCents: 10000 },
        netAmountInHostCurrency: { valueInCents: 10000 },
        paymentProcessorFee: { valueInCents: 0 },
        isRefund: false,
      },
      {
        kind: 'EXPENSE',
        type: 'DEBIT',
        amountInHostCurrency: { valueInCents: -10000 },
        netAmountInHostCurrency: { valueInCents: -10390 },
        paymentProcessorFee: { valueInCents: -390 },
        isRefund: false,
      },
      // Refund Transactions
      {
        kind: 'EXPENSE',
        type: 'DEBIT',
        amountInHostCurrency: { valueInCents: -10000 },
        paymentProcessorFee: { valueInCents: 0 },
        netAmountInHostCurrency: { valueInCents: -10000 },
        isRefund: true,
      },
      {
        kind: 'EXPENSE',
        type: 'CREDIT',
        amountInHostCurrency: { valueInCents: 10000 },
        paymentProcessorFee: { valueInCents: 390 },
        netAmountInHostCurrency: { valueInCents: 10390 },
        isRefund: true,
      },
      {
        kind: 'PAYMENT_PROCESSOR_FEE',
        type: 'CREDIT',
        amountInHostCurrency: { valueInCents: 390 },
        netAmountInHostCurrency: { valueInCents: 390 },
        paymentProcessorFee: { valueInCents: 0 },
        isRefund: true,
      },
      {
        kind: 'PAYMENT_PROCESSOR_FEE',
        type: 'DEBIT',
        amountInHostCurrency: { valueInCents: -390 },
        netAmountInHostCurrency: { valueInCents: -390 },
        paymentProcessorFee: { valueInCents: 0 },
        isRefund: true,
      },
    ]);
  });

  describe('clearedAt', () => {
    it('should fetch clearedAt date', async () => {
      const transaction = await fakeTransaction(
        { amount: 1000, CollectiveId: expense.CollectiveId, clearedAt: new Date('2024-02-20T00:00:00Z') },
        { createDoubleEntry: true },
      );
      const query = `
      query Transaction($id: String!) {
        transaction(id: $id) {
          id
          legacyId
          clearedAt
          createdAt
        }
      }
    `;

      const result = await graphqlQueryV2(query, { id: transaction.uuid }, hostAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.transaction.clearedAt.toISOString()).to.equal('2024-02-20T00:00:00.000Z');
      expect(result.data.transaction.createdAt.toISOString()).to.not.equal('2024-02-20T00:00:00.000Z');
    });

    it('should default to createdAt if null', async () => {
      const transaction = await fakeTransaction(
        { amount: 1000, CollectiveId: expense.CollectiveId, clearedAt: null },
        { createDoubleEntry: true },
      );
      const query = `
      query Transaction($id: String!) {
        transaction(id: $id) {
          id
          legacyId
          clearedAt
          createdAt
        }
      }
    `;

      const result = await graphqlQueryV2(query, { id: transaction.uuid }, hostAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.transaction.clearedAt.toISOString()).to.equal(transaction.createdAt.toISOString());
    });
  });
});
