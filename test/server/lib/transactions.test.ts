import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';
import Stripe from 'stripe';

import { SupportedCurrency } from '../../../server/constants/currencies';
import { PAYMENT_METHOD_SERVICE } from '../../../server/constants/paymentMethods';
import * as libtransactions from '../../../server/lib/transactions';
import models from '../../../server/models';
import * as store from '../../stores';
import { fakeActiveHost, fakeCollective, fakeExpense, fakePaymentMethod, randStr } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

describe('server/lib/transactions', () => {
  beforeEach(async () => {
    await utils.resetTestDB();
    await utils.seedDefaultVendors();
  });

  it('exports transactions', async () => {
    // Given a host with a collective
    const currency = 'USD';
    const { collective } = await store.newCollectiveWithHost('apex', currency, currency, '10');
    const { user } = await store.newUser('a new user');
    // And given some transactions
    await store.stripeConnectedAccount(collective.HostCollectiveId);
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 100,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 200,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 300,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 400,
    });
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount: 500,
    });
    const transactions = await models.Transaction.findAll({
      where: { CollectiveId: collective.id },
    });
    // Expected total
    // - 5 for CONTRIBUTIONs
    // - 5 for HOST_FEEs
    expect(transactions.length).to.equal(10);
    // When the newly created transactions are exported
    const csv = libtransactions.exportTransactions(transactions);
    const lines = csv.split('\n');
    expect(lines.length).to.equal(11);
    expect(lines[0].split('","').length).to.equal(12);
  }); /* End of "exports transactions" */

  describe('createTransactionsFromPaidExpense', () => {
    const sandbox = createSandbox();
    beforeEach(async () => {
      sandbox.stub(config.ledger, 'separatePaymentProcessorFees').value(true);
      await utils.seedDefaultVendors();
    });
    afterEach(() => sandbox.restore());

    it('creates transactions with clearedAt date for a paid expense', async () => {
      const expense = await fakeExpense({ amount: 10000, status: 'PAID' });

      await libtransactions.createTransactionsFromPaidExpense(
        expense.collective.host,
        expense,
        {
          hostFeeInHostCurrency: 0,
          platformFeeInHostCurrency: 0,
          paymentProcessorFeeInHostCurrency: -390,
        },
        1,
        { clearedAt: new Date('2024-02-20T00:00:00Z') },
      );

      const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
      expect(transactions).to.not.be.empty;
      for (const transaction of transactions) {
        expect(transaction.clearedAt.toISOString()).to.equal('2024-02-20T00:00:00.000Z');
      }
    });
  });

  describe('createTransactionsForManuallyPaidExpense', () => {
    const sandbox = createSandbox();
    beforeEach(async () => {
      sandbox.stub(config.ledger, 'separatePaymentProcessorFees').value(true);
      await utils.seedDefaultVendors();
    });
    afterEach(() => sandbox.restore());

    it('creates transactions with clearedAt date for a paid expense', async () => {
      const expense = await fakeExpense({ amount: 10000, status: 'PAID' });

      await libtransactions.createTransactionsForManuallyPaidExpense(expense.collective.host, expense, 100, 9900, {
        clearedAt: new Date('2024-02-20T00:00:00Z'),
      });

      const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
      expect(transactions).to.not.be.empty;
      for (const transaction of transactions) {
        expect(transaction.clearedAt.toISOString()).to.equal('2024-02-20T00:00:00.000Z');
      }
    });
  });

  describe('createTransactionsFromPaidStripeExpense', () => {
    const sandbox = createSandbox();
    beforeEach(async () => {
      sandbox.stub(config.ledger, 'separatePaymentProcessorFees').value(true);
      await utils.seedDefaultVendors();
    });
    afterEach(() => sandbox.restore());

    describe('creates transactions for paid expense', () => {
      const scenarios = {
        'same currencies': {
          only: false,
          payeeHostCurrency: 'USD',
          payeeCollectiveCurrency: 'USD',
          expenseCurrency: 'USD',
          amount: 100e2,
          balanceTxnCurrency: 'USD',
          payeeHostFeePercent: 10,
          paymentProcessorFee: 10e2,
          results: {
            hostFeeTxn: {
              amount: ((100e2 - 10e2) * 10) / 100,
              currency: 'USD',
            },
            payeeTxn: {
              amount: 100e2,
              currency: 'USD',
            },
            paymentProcessorTxn: {
              amount: -10e2,
              currency: 'USD',
            },
            payerTxn: {
              amount: -100e2,
              currency: 'USD',
            },
          },
        },
        'different expense currency': {
          only: false,
          payeeHostCurrency: 'USD',
          payeeCollectiveCurrency: 'USD',
          expenseCurrency: 'BRL',
          amount: 100e2,
          balanceTxnCurrency: 'USD',
          payeeHostFeePercent: 10,
          paymentProcessorFee: 10e2,
          results: {
            hostFeeTxn: {
              amount: ((100e2 - 10e2) * 10) / 100,
              currency: 'USD',
            },
            payeeTxn: {
              amount: 100e2,
              currency: 'USD',
            },
            paymentProcessorTxn: {
              amount: -10e2,
              currency: 'USD',
            },
            payerTxn: {
              amount: -100e2,
              currency: 'USD',
            },
          },
        },
        'different payee and host currency': {
          only: false,
          payeeHostCurrency: 'USD',
          payeeCollectiveCurrency: 'BRL',
          expenseCurrency: 'USD',
          amount: 100e2,
          balanceTxnCurrency: 'USD',
          payeeHostFeePercent: 10,
          paymentProcessorFee: 10e2,
          results: {
            hostFeeTxn: {
              amount: ((110e2 - 11e2) * 10) / 100,
              currency: 'BRL',
            },
            payeeTxn: {
              amount: 110e2,
              currency: 'BRL',
            },
            paymentProcessorTxn: {
              amount: -11e2,
              currency: 'BRL',
            },
            payerTxn: {
              amount: -110e2,
              currency: 'BRL',
            },
          },
        },
      };

      Object.entries(scenarios).forEach(([name, scenario]) => {
        const fn = scenario.only ? it.only : it;
        fn(name, async () => {
          const host = await fakeActiveHost({
            currency: scenario.payeeHostCurrency as SupportedCurrency,
            hostFeePercent: scenario.payeeHostFeePercent,
          });
          const paymentMethod = await fakePaymentMethod({
            service: PAYMENT_METHOD_SERVICE.STRIPE,
            CollectiveId: host.id,
          });
          const payee = await fakeCollective({
            HostCollectiveId: host.id,
            currency: scenario.payeeCollectiveCurrency as SupportedCurrency,
          });
          const expense = await fakeExpense({
            PaymentMethodId: paymentMethod.id,
            amount: scenario.amount,
            currency: scenario.expenseCurrency,
            status: 'PAID',
            FromCollectiveId: payee.id,
          });

          const balanceTransaction = {
            amount: scenario.amount,
            currency: scenario.balanceTxnCurrency,
            fee: scenario.paymentProcessorFee,
            // eslint-disable-next-line camelcase
            available_on: new Date().getTime(),
          } as Stripe.BalanceTransaction;

          const charge = {
            id: randStr('ch_fake'),
          } as Stripe.Charge;

          await libtransactions.createTransactionsFromPaidStripeExpense(expense, balanceTransaction, charge);

          const expectedTxnCount =
            2 + (scenario.paymentProcessorFee > 0 ? 2 : 0) + (scenario.payeeHostFeePercent > 0 ? 2 : 0);
          const transactions = await models.Transaction.findAll({ where: { ExpenseId: expense.id } });
          expect(transactions).to.have.length(expectedTxnCount);

          expect(
            transactions.find(t => t.type === 'CREDIT' && t.kind === 'EXPENSE' && t.CollectiveId === payee.id)
              .dataValues,
            'expense credit',
          ).to.containSubset(scenario.results.payeeTxn);

          expect(
            transactions.find(
              t => t.type === 'DEBIT' && t.kind === 'EXPENSE' && t.CollectiveId === expense.CollectiveId,
            ).dataValues,
            'expense debit',
          ).to.containSubset(scenario.results.payerTxn);

          if (scenario.paymentProcessorFee > 0) {
            expect(
              transactions.find(
                t => t.type === 'DEBIT' && t.kind === 'PAYMENT_PROCESSOR_FEE' && t.CollectiveId === payee.id,
              ).dataValues,
              'payment processor debit',
            ).to.containSubset(scenario.results.paymentProcessorTxn);
          }

          if (scenario.payeeHostFeePercent > 0) {
            expect(
              transactions.find(t => t.type === 'DEBIT' && t.kind === 'HOST_FEE' && t.CollectiveId === payee.id)
                .dataValues,
              'host fee debit',
            ).to.containSubset({
              amount: -scenario.results.hostFeeTxn.amount,
              currency: scenario.results.hostFeeTxn.currency,
            });

            expect(
              transactions.find(t => t.type === 'CREDIT' && t.kind === 'HOST_FEE' && t.CollectiveId === host.id)
                .dataValues,
              'payment processor credit',
            ).to.containSubset(scenario.results.hostFeeTxn);
          }
        });
      });
    });
  });
}); /* End of "lib.transactions.test.js" */
