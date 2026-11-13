/* eslint-disable camelcase */
import paypalPayoutsSDK from '@paypal/payouts-sdk';
import * as SentrySdk from '@sentry/node';
import { expect } from 'chai';
import config from 'config';
import type { SinonStub } from 'sinon';
import { assert, createSandbox } from 'sinon';

import status from '../../../../server/constants/expense-status';
import * as paypalLib from '../../../../server/lib/paypal';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import * as paypalPayouts from '../../../../server/paymentProviders/paypal/payouts';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeHost,
  fakePayoutMethod,
  fakeUser,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';
/** `sandbox.stub(obj, key)` replaces the method: cast it back to the sinon stub for chaining. */
const stubOf = (fn: (...args: never[]) => unknown) => fn as SinonStub;

describe('server/paymentProviders/paypal/payouts.js', () => {
  let expense, host, collective, payoutMethod, sandbox, metricsCountStub;

  beforeEach(async () => {
    await utils.resetTestDB({ groupedTruncate: false });
    sandbox = createSandbox();
    sandbox.stub(config, 'sentry').value({ dsn: 'https://sentry.io/123' });
    metricsCountStub = sandbox.stub(SentrySdk.metrics, 'count');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('payExpensesBatch', () => {
    let expense, expense2, host, collective, payoutMethod;
    beforeEach(async () => {
      host = await fakeHost({ currency: 'USD' });
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'paypal',
        clientId: 'fake',
        token: 'fake',
      });
      collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD', name: 'Great Future' });
      payoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'nicolas@cage.com',
        },
      });
      expense = await fakeExpense({
        status: status.SCHEDULED_FOR_PAYMENT,
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'May Invoice',
        reference: '@VeryUn1queRef!',
      });
      expense2 = await fakeExpense({
        status: status.SCHEDULED_FOR_PAYMENT,
        amount: 424,
        CollectiveId: collective.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'Stuff',
      });
      await fakeExpense({
        status: status.PAID,
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense.collective = collective;
      expense2.collective = collective;
      expense.PayoutMethod = payoutMethod;
      expense2.PayoutMethod = payoutMethod;
      sandbox.stub(paypalLib, 'executePayouts').resolves({ batch_header: { payout_batch_id: 'fake' } });
    });

    it('should pay all expenses scheduled for payment', async () => {
      await paypalPayouts.payExpensesBatch([expense, expense2]);
      await expense.reload();

      assert.calledOnce(paypalLib.executePayouts);
      expect(stubOf(paypalLib.executePayouts).getCall(0).args[1]).to.containSubset({
        sender_batch_header: {
          recipient_type: 'EMAIL',
          email_message: 'Good news, your expense was paid!',
          email_subject: `Expense Payout for Great Future`,
        },
        items: [
          {
            note: 'Expense #1: May Invoice (@VeryUn1queRef!)',
            receiver: 'nicolas@cage.com',
            amount: { currency: 'USD', value: '100' },
          },
          {
            note: 'Expense #2: Stuff',
            receiver: 'nicolas@cage.com',
            amount: { currency: 'USD', value: '4.24' },
          },
        ],
      });

      expect(expense.data).to.deep.equals({ payout_batch_id: 'fake' });
      expect(expense).to.have.property('status', status.PROCESSING);

      // Check that the activity includes the payout response data
      const processingActivities = await expense.getActivities({ where: { type: 'collective.expense.processing' } });
      expect(processingActivities).to.have.length(1);
      expect(processingActivities[0].data).to.deep.include({ payoutResponse: { payout_batch_id: 'fake' } });
    });

    it('records a failed payment outcome metric for each expense when the batch submit fails', async () => {
      stubOf(paypalLib.executePayouts).rejects({
        message: 'PayPal refused the payout batch',
        metadata: { error: { name: 'INTERNAL_ERROR', details: [{ issue: 'INTERNAL_ERROR' }] } },
      });

      await paypalPayouts.payExpensesBatch([expense]);
      await expense.reload();

      expect(expense).to.have.property('status', status.ERROR);
      expect(metricsCountStub).to.have.been.calledOnce;
      expect(metricsCountStub.firstCall.args).to.deep.equal([
        'thirdparty.paypal.payment.failed',
        1,
        { attributes: { flow: 'payout', method: 'PAYPAL', error_type: 'provider_error' } },
      ]);
    });

    it('should mark expenses as ERROR when executePayouts returns a PayoutError', async () => {
      const payoutError = {
        name: 'VALIDATION_ERROR',
        message: 'Invalid request - see details',
        debug_id: 'abc123',
        details: [
          {
            field: 'items[0].amount.value',
            issue: 'AMOUNT_INVALID',
            description: 'Amount is invalid',
          },
        ],
      };

      stubOf(paypalLib.executePayouts).resolves(payoutError);

      await paypalPayouts.payExpensesBatch([expense, expense2]);
      await expense.reload();
      await expense2.reload();

      assert.calledOnce(paypalLib.executePayouts);
      expect(expense).to.have.property('status', status.ERROR);
      expect(expense2).to.have.property('status', status.ERROR);
      expect(expense.data.error).to.deep.equal(payoutError);
      expect(expense2.data.error).to.deep.equal(payoutError);
    });

    it('should mark expenses as ERROR when the PayPal request fails but executePayouts returns a parsed error', async () => {
      // Use the real executePayouts to cover its parse-on-failure path
      stubOf(paypalLib.executePayouts).restore();
      const payoutError = {
        name: 'VALIDATION_ERROR',
        message: 'Invalid request - see details',
        debug_id: 'abc123',
        details: [
          {
            field: 'items[0].amount.value',
            issue: 'AMOUNT_INVALID',
            description: 'Amount is invalid',
          },
        ],
      };
      const execute = sandbox
        .stub()
        .rejects(Object.assign(new Error(JSON.stringify(payoutError)), { statusCode: 400 }));
      sandbox.stub(paypalPayoutsSDK.core, 'PayPalHttpClient').returns({ execute });

      await paypalPayouts.payExpensesBatch([expense]);
      await expense.reload();

      assert.calledOnce(execute);
      expect(expense).to.have.property('status', status.ERROR);
      expect(expense.data.error).to.deep.equal(payoutError);
      const errorActivities = await expense.getActivities({ where: { type: 'collective.expense.error' } });
      expect(errorActivities).to.have.length(1);
      expect(errorActivities[0].data.error).to.deep.equal(payoutError);
    });

    it('should mark expenses as ERROR and record an activity when executePayouts returns an unexpected response', async () => {
      stubOf(paypalLib.executePayouts).resolves({ unexpected: 'response' });

      await paypalPayouts.payExpensesBatch([expense]);
      await expense.reload();

      expect(expense).to.have.property('status', status.ERROR);
      const errorActivities = await expense.getActivities({ where: { type: 'collective.expense.error' } });
      expect(errorActivities).to.have.length(1);
      expect(errorActivities[0].data.error).to.have.property(
        'message',
        'PayPal Payouts response failed to return batch_header',
      );
    });
  });

  describe('checkBatchStatus', () => {
    beforeEach(async () => {
      host = await fakeCollective({ hasMoneyManagement: true });
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'paypal',
        clientId: 'fake',
        token: 'fake',
      });
      collective = await fakeCollective({ HostCollectiveId: host.id });
      payoutMethod = await fakePayoutMethod({
        type: PayoutMethodTypes.PAYPAL,
        data: {
          email: 'nicolas@cage.com',
        },
      });
      expense = await fakeExpense({
        status: status.PROCESSING,
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'May Invoice',
        data: { payout_batch_id: 'fake-batch-id' },
      });
      await fakeExpense({
        status: status.PAID,
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'USD',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'January Invoice',
      });
      expense.collective = collective;
      sandbox.stub(paypalLib, 'getBatchInfo');
    });

    it('should create a transaction and mark expense as paid if transaction status is SUCCESS', async () => {
      stubOf(paypalLib.getBatchInfo).resolves({
        items: [
          {
            transaction_status: 'SUCCESS',
            payout_item: { sender_item_id: expense.id.toString() },
            payout_batch_id: 'fake-batch-id',
            payout_item_fee: {
              currency: 'USD',
              value: '1.23',
            },
            time_processed: '2024-08-15T10:30:00Z',
          },
        ],
      });

      await paypalPayouts.checkBatchStatus([expense]);
      const [transaction] = await expense.getTransactions({ where: { type: 'DEBIT' } });

      expect(stubOf(paypalLib.getBatchInfo).getCall(0)).to.have.property('lastArg', 'fake-batch-id');
      expect(expense).to.have.property('status', 'PAID');
      expect(expense.paidAt).to.be.a('date');
      expect(expense.paidAt.toISOString()).to.eq(new Date('2024-08-15T10:30:00Z').toISOString());
      expect(transaction).to.have.property('paymentProcessorFeeInHostCurrency', -123);
      expect(transaction).to.have.property('netAmountInCollectiveCurrency', -10123);

      // Check that the paid activity includes the payout item data
      const paidActivities = await expense.getActivities({ where: { type: 'collective.expense.paid' } });
      expect(paidActivities).to.have.length(1);
      expect(paidActivities[0].data).to.containSubset({
        payoutItem: {
          transaction_status: 'SUCCESS',
          payout_batch_id: 'fake-batch-id',
          payout_item_fee: { currency: 'USD', value: '1.23' },
          time_processed: '2024-08-15T10:30:00Z',
        },
      });
    });

    it('records a successful payment outcome metric when the payout item succeeds', async () => {
      stubOf(paypalLib.getBatchInfo).resolves({
        items: [
          {
            transaction_status: 'SUCCESS',
            payout_item: { sender_item_id: expense.id.toString() },
            payout_batch_id: 'fake-batch-id',
            time_processed: '2024-08-15T10:30:00Z',
          },
        ],
      });

      await paypalPayouts.checkBatchStatus([expense]);

      expect(expense).to.have.property('status', 'PAID');
      expect(metricsCountStub).to.have.been.calledOnce;
      expect(metricsCountStub.firstCall.args).to.deep.equal([
        'thirdparty.paypal.payment.succeeded',
        1,
        { attributes: { flow: 'payout', method: 'PAYPAL' } },
      ]);
    });

    it('work with cross-currency collectives', async () => {
      const collectiveInEur = await fakeCollective({ currency: 'EUR', HostCollectiveId: host.id });
      const expense = await fakeExpense({
        status: status.PROCESSING,
        amount: 10000,
        CollectiveId: collectiveInEur.id,
        currency: 'EUR',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'May Invoice',
        data: { payout_batch_id: 'fake-batch-id-eur' },
      });
      expense.collective = collectiveInEur;

      stubOf(paypalLib.getBatchInfo).resolves({
        items: [
          {
            transaction_status: 'SUCCESS',
            payout_item: { sender_item_id: expense.id.toString() },
            payout_batch_id: 'fake-batch-id-eur',
            payout_item_fee: {
              currency: 'EUR',
              value: '1.20',
            },
            currency_conversion: {
              to_amount: { value: '100.00', currency: 'EUR' },
              from_amount: { value: '125.00', currency: 'USD' },
              exchange_rate: '0.80',
            },
          },
        ],
      });

      await paypalPayouts.checkBatchStatus([expense]);
      const [transaction] = await expense.getTransactions({ where: { type: 'DEBIT' } });

      expect(stubOf(paypalLib.getBatchInfo).getCall(0)).to.have.property('lastArg', 'fake-batch-id-eur');
      expect(expense).to.have.property('status', 'PAID');
      expect(transaction).to.have.property('paymentProcessorFeeInHostCurrency', -150); // 1.20 / 0.8
      expect(transaction).to.have.property('amountInHostCurrency', -12500);
      expect(transaction).to.have.property('hostCurrency', 'USD');
      expect(transaction).to.have.property('netAmountInCollectiveCurrency', -10120);
      expect(transaction).to.have.property('currency', collectiveInEur.currency); // EUR
      expect(transaction).to.have.property('amount', -10000); // EUR
    });

    it("work with cross-currency expense (but collective's still using host currency)", async () => {
      // Here expense=EUR, collective=USD, host=USD
      const expense = await fakeExpense({
        status: status.PROCESSING,
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'EUR',
        PayoutMethodId: payoutMethod.id,
        category: 'Engineering',
        type: 'INVOICE',
        description: 'May Invoice',
        data: { payout_batch_id: 'fake-batch-id-eur' },
      });
      expense.collective = collective;

      stubOf(paypalLib.getBatchInfo).resolves({
        items: [
          {
            transaction_status: 'SUCCESS',
            payout_item: { sender_item_id: expense.id.toString() },
            payout_batch_id: 'fake-batch-id-eur',
            payout_item_fee: {
              currency: 'EUR',
              value: '1.20',
            },
            currency_conversion: {
              to_amount: { value: '100.00', currency: 'EUR' },
              from_amount: { value: '125.00', currency: 'USD' },
              exchange_rate: '0.80',
            },
          },
        ],
      });

      const paymentProcessorFeeInExpenseCurrency = 120; // As defined in the mock
      const paymentProcessorFeeInHostCurrency = paymentProcessorFeeInExpenseCurrency / 0.8;
      const expenseAmountInHostCurrency = expense.amount / 0.8;

      await paypalPayouts.checkBatchStatus([expense]);
      const [transaction] = await expense.getTransactions({ where: { type: 'DEBIT' } });

      expect(stubOf(paypalLib.getBatchInfo).getCall(0)).to.have.property('lastArg', 'fake-batch-id-eur');
      expect(expense).to.have.property('status', 'PAID');
      expect(transaction).to.have.property('paymentProcessorFeeInHostCurrency', -paymentProcessorFeeInHostCurrency);
      expect(transaction).to.have.property('amountInHostCurrency', -12500);
      expect(transaction).to.have.property('hostCurrency', 'USD');
      expect(transaction).to.have.property('currency', collective.currency); // USD
      expect(transaction).to.have.property('amount', -12500); // USD
      expect(transaction).to.have.property(
        'netAmountInCollectiveCurrency',
        -expenseAmountInHostCurrency - paymentProcessorFeeInHostCurrency,
      );
    });

    it('uses the internal FX rate for a cross-currency expense paid without PayPal conversion', async () => {
      // Here expense=EUR, collective=USD, host=USD and the host paid from its EUR PayPal balance
      const expense = await fakeExpense({
        status: status.PROCESSING,
        amount: 10000,
        CollectiveId: collective.id,
        currency: 'EUR',
        PayoutMethodId: payoutMethod.id,
        type: 'INVOICE',
        description: 'May Invoice',
        data: { payout_batch_id: 'fake-batch-id-eur' },
      });
      expense.collective = collective;

      stubOf(paypalLib.getBatchInfo).resolves({
        items: [
          {
            transaction_status: 'SUCCESS',
            payout_batch_id: 'fake-batch-id-eur',
            // Same currency as sent by payExpensesBatch, with no `currency_conversion`
            payout_item: { sender_item_id: expense.id.toString(), amount: { currency: 'EUR', value: '100.00' } },
            payout_item_fee: { currency: 'EUR', value: '2.00' },
          },
        ],
      });

      await paypalPayouts.checkBatchStatus([expense]);
      await expense.reload();
      const [transaction] = await expense.getTransactions({ where: { type: 'DEBIT' } });

      expect(expense).to.have.property('status', 'PAID');
      expect(transaction).to.have.property('hostCurrency', 'USD');
      expect(transaction.data.expenseToHostFxRate).to.eq(1.1); // getFxRate(EUR, USD) in the test env
      expect(transaction).to.have.property('amountInHostCurrency', -11000);
      expect(transaction).to.have.property('paymentProcessorFeeInHostCurrency', -220);
    });

    describe('expense data', () => {
      const taxes = [{ type: 'VAT', rate: 0.2 }];
      let taxedExpense;

      beforeEach(async () => {
        taxedExpense = await fakeExpense({
          status: status.PROCESSING,
          amount: 12000,
          CollectiveId: collective.id,
          currency: 'USD',
          PayoutMethodId: payoutMethod.id,
          type: 'INVOICE',
          data: { payout_batch_id: 'fake-batch-id-taxed', taxes, otherKey: 'preserved' },
        });
        taxedExpense.collective = collective;
      });

      const buildItem = (transaction_status: string, overrides = {}) => ({
        transaction_status,
        payout_batch_id: 'fake-batch-id-taxed',
        payout_item: { sender_item_id: taxedExpense.id.toString() },
        ...overrides,
      });

      it('keeps the existing data when the payout item is still PENDING', async () => {
        stubOf(paypalLib.getBatchInfo).resolves({ items: [buildItem('PENDING')] });
        await paypalPayouts.checkBatchStatus([taxedExpense]);
        await taxedExpense.reload();

        expect(taxedExpense).to.have.property('status', 'PROCESSING');
        expect(taxedExpense.data).to.containSubset({ taxes, otherKey: 'preserved', transaction_status: 'PENDING' });
      });

      it('records the taxes when a PENDING check comes before SUCCESS', async () => {
        stubOf(paypalLib.getBatchInfo).resolves({ items: [buildItem('PENDING')] });
        await paypalPayouts.checkBatchStatus([taxedExpense]);
        stubOf(paypalLib.getBatchInfo).resolves({
          items: [buildItem('SUCCESS', { time_processed: '2024-08-15T10:30:00Z' })],
        });
        await paypalPayouts.checkBatchStatus([taxedExpense]);
        await taxedExpense.reload();

        expect(taxedExpense).to.have.property('status', 'PAID');
        expect(taxedExpense.data).to.containSubset({ taxes, otherKey: 'preserved', transaction_status: 'SUCCESS' });
        const [debit] = await taxedExpense.getTransactions({ where: { type: 'DEBIT', kind: 'EXPENSE' } });
        expect(debit).to.have.property('taxAmount', -2000);
      });

      it('keeps the existing data and drops the batch reference when the payout item FAILED', async () => {
        stubOf(paypalLib.getBatchInfo).resolves({
          items: [buildItem('FAILED', { errors: { message: 'Transaction FAILED' } })],
        });
        await paypalPayouts.checkBatchStatus([taxedExpense]);
        await taxedExpense.reload();

        expect(taxedExpense).to.have.property('status', 'ERROR');
        expect(taxedExpense.data).to.containSubset({ taxes, otherKey: 'preserved', transaction_status: 'FAILED' });
        expect(taxedExpense.data).to.not.have.property('payout_batch_id');
      });
    });

    const failedStatuses = ['FAILED', 'BLOCKED', 'REFUNDED', 'RETURNED', 'REVERSED'];
    failedStatuses.map(transaction_status =>
      it(`should set expense status to error if the transaction status is ${transaction_status}`, async () => {
        const payoutItem = {
          transaction_status,
          payout_batch_id: 'fake-batch-id',
          payout_item: { sender_item_id: expense.id.toString() },
          errors: { message: `Transaction ${transaction_status}` },
        };
        stubOf(paypalLib.getBatchInfo).resolves({ items: [payoutItem] });
        await paypalPayouts.checkBatchStatus([expense]);
        const transactions = await expense.getTransactions({ where: { type: 'DEBIT' } });

        expect(expense).to.have.property('status', 'ERROR');
        expect(transactions).to.have.length(0);

        // Check that the error activity includes the payout item data
        const errorActivities = await expense.getActivities({ where: { type: 'collective.expense.error' } });
        expect(errorActivities).to.have.length(1);
        expect(errorActivities[0].data).to.containSubset({
          payoutItem: { transaction_status, payout_batch_id: 'fake-batch-id' },
        });

        // Failed payout item settles the attempt terminally: exactly one metric with the mapped error type
        expect(metricsCountStub).to.have.been.calledOnce;
        expect(metricsCountStub.firstCall.args).to.deep.equal([
          'thirdparty.paypal.payment.failed',
          1,
          {
            attributes: {
              flow: 'payout',
              method: 'PAYPAL',
              error_type: transaction_status === 'REFUNDED' ? 'funds_refunded' : 'provider_error',
            },
          },
        ]);
      }),
    );

    describe('payout item errors at batch review', () => {
      const buildFailedItem = (overrides = {}) => ({
        transaction_status: 'FAILED',
        payout_item_id: 'payout-item-1',
        payout_batch_id: 'fake-batch-id',
        payout_item: { sender_item_id: expense.id.toString() },
        ...overrides,
      });

      const getErrorActivity = async () => {
        const activities = await expense.getActivities({ where: { type: 'collective.expense.error' } });
        expect(activities).to.have.length(1);
        return activities[0];
      };

      it('uses the errors included in the batch item without fetching the payout item', async () => {
        sandbox.stub(paypalLib, 'getPayoutItem');
        stubOf(paypalLib.getBatchInfo).resolves({
          items: [
            buildFailedItem({
              errors: {
                name: 'RECEIVER_COUNTRY_NOT_ALLOWED',
                message: 'The receiver country is not allowed.',
                debug_id: 'debug-1',
                details: [{ issue: 'RECEIVER_COUNTRY_NOT_ALLOWED', field: 'items[0].receiver' }],
              },
            }),
          ],
        });

        await paypalPayouts.checkBatchStatus([expense]);

        expect(expense).to.have.property('status', 'ERROR');
        expect(paypalLib.getPayoutItem).to.not.have.been.called;
        // The raw payload is persisted (debug data included); `sanitizeErrorData` gates exposure
        expect((await getErrorActivity()).data.error).to.deep.equal({
          name: 'RECEIVER_COUNTRY_NOT_ALLOWED',
          message: 'The receiver country is not allowed.',
          debug_id: 'debug-1',
          details: [{ issue: 'RECEIVER_COUNTRY_NOT_ALLOWED', field: 'items[0].receiver' }],
        });
      });

      it('fetches the payout item when a failed item has no errors', async () => {
        const getPayoutItemStub = sandbox.stub(paypalLib, 'getPayoutItem');
        getPayoutItemStub.resolves({
          payout_item_id: 'payout-item-1',
          transaction_id: 'transaction-1',
          transaction_status: 'FAILED',
          errors: {
            name: 'RECEIVING_LIMIT_EXCEEDED',
            message: 'The receiver has exceeded the receiving limit.',
            debug_id: 'debug-2',
            details: [{ issue: 'RECEIVING_LIMIT_EXCEEDED', field: 'items[0].receiver' }],
          },
        });
        stubOf(paypalLib.getBatchInfo).resolves({ items: [buildFailedItem()] });

        await paypalPayouts.checkBatchStatus([expense]);

        expect(expense).to.have.property('status', 'ERROR');
        expect(getPayoutItemStub).to.have.been.calledOnce;
        expect(getPayoutItemStub.getCall(0).args[1]).to.equal('payout-item-1');
        const { data } = await getErrorActivity();
        expect(data.error).to.deep.equal({
          name: 'RECEIVING_LIMIT_EXCEEDED',
          message: 'The receiver has exceeded the receiving limit.',
          debug_id: 'debug-2',
          details: [{ issue: 'RECEIVING_LIMIT_EXCEEDED', field: 'items[0].receiver' }],
        });
        // The whole payout item detail is kept for debugging
        expect(data.payoutItem).to.deep.contain({
          payout_item_id: 'payout-item-1',
          transaction_id: 'transaction-1',
          transaction_status: 'FAILED',
        });
        expect(data).to.not.have.property('errorRetrievalFailed');
      });

      it('stores a status-derived message when the payout item endpoint has no errors either', async () => {
        sandbox.stub(paypalLib, 'getPayoutItem').resolves({
          payout_item_id: 'payout-item-1',
          transaction_id: 'transaction-1',
          transaction_status: 'FAILED',
        });
        stubOf(paypalLib.getBatchInfo).resolves({ items: [buildFailedItem()] });

        await paypalPayouts.checkBatchStatus([expense]);

        expect(expense).to.have.property('status', 'ERROR');
        const { data } = await getErrorActivity();
        expect(data.error).to.deep.equal({ message: 'PayPal payout item FAILED' });
        expect(data.payoutItem).to.deep.contain({ transaction_id: 'transaction-1' });
        // A successful lookup with no errors is conclusive, so it is not retried
        expect(data).to.not.have.property('errorRetrievalFailed');
      });

      it('stores a status-derived message when fetching the payout item fails', async () => {
        sandbox.stub(paypalLib, 'getPayoutItem').rejects(new Error('PayPal is unavailable'));
        stubOf(paypalLib.getBatchInfo).resolves({ items: [buildFailedItem({ transaction_status: 'BLOCKED' })] });

        await paypalPayouts.checkBatchStatus([expense]);

        expect(expense).to.have.property('status', 'ERROR');
        const { data } = await getErrorActivity();
        expect(data.error).to.deep.equal({ message: 'PayPal payout item BLOCKED' });
        expect(data.payoutItem).to.deep.contain({ payout_item_id: 'payout-item-1' });
        // Flagged so the backfill script retries the retrieval instead of treating it as conclusive
        expect(data.errorRetrievalFailed).to.equal(true);
      });

      it('does not fetch the payout item for successful items', async () => {
        sandbox.stub(paypalLib, 'getPayoutItem');
        stubOf(paypalLib.getBatchInfo).resolves({
          items: [
            {
              transaction_status: 'SUCCESS',
              payout_item_id: 'payout-item-1',
              payout_item: { sender_item_id: expense.id.toString() },
              payout_batch_id: 'fake-batch-id',
              time_processed: '2024-08-15T10:30:00Z',
            },
          ],
        });

        await paypalPayouts.checkBatchStatus([expense]);

        expect(expense).to.have.property('status', 'PAID');
        expect(paypalLib.getPayoutItem).to.not.have.been.called;
      });
    });
  });

  describe('estimatePaypalPayoutFee', () => {
    it('returns 2% for domestic payout when below cap', async () => {
      const host = await fakeHost({ currency: 'USD', countryISO: 'US' });
      const payeeUser = await fakeUser({}, { countryISO: 'US' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payeeUser.CollectiveId,
        UserId: payeeUser.id,
        amount: 10000,
        currency: 'USD',
      });

      const fee = await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, expense);

      expect(fee).to.equal(200); // 2% of $100 = $2 = 200 cents
    });

    it('returns domestic cap for domestic payout when 2% exceeds cap', async () => {
      const host = await fakeHost({ currency: 'USD', countryISO: 'US' });
      const payeeUser = await fakeUser({}, { countryISO: 'US' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payeeUser.CollectiveId,
        UserId: payeeUser.id,
        amount: 100000,
        currency: 'USD',
      });

      const fee = await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, expense);

      expect(fee).to.equal(1400); // USD domestic cap = $14 = 1400 cents
    });

    it('returns 2% for international payout when below cap', async () => {
      const host = await fakeHost({ currency: 'USD', countryISO: 'US' });
      const payeeUser = await fakeUser({}, { countryISO: 'FR' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payeeUser.CollectiveId,
        UserId: payeeUser.id,
        amount: 10000,
        currency: 'USD',
      });

      const fee = await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, expense);

      expect(fee).to.equal(200); // 2% of $100 = $2 = 200 cents
    });

    it('returns international cap for international payout when 2% exceeds cap', async () => {
      const host = await fakeHost({ currency: 'USD', countryISO: 'US' });
      const payeeUser = await fakeUser({}, { countryISO: 'FR' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payeeUser.CollectiveId,
        UserId: payeeUser.id,
        amount: 500000,
        currency: 'USD',
      });

      const fee = await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, expense);

      expect(fee).to.equal(9000); // USD international cap = $90 = 9000 cents
    });

    it('returns uncapped 2% for unknown currency', async () => {
      const host = await fakeHost({ currency: 'INR', countryISO: 'IN' });
      const payeeUser = await fakeUser({}, { countryISO: 'IN' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'INR' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payeeUser.CollectiveId,
        UserId: payeeUser.id,
        amount: 100000,
        currency: 'INR',
      });

      const fee = await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, expense);

      expect(fee).to.equal(2000); // 2% of 100000 = 2000 (no cap for INR)
    });

    it('uses the cap of the expense currency, not the host currency', async () => {
      const host = await fakeHost({ currency: 'USD', countryISO: 'US' });
      const payeeUser = await fakeUser({}, { countryISO: 'US' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payeeUser.CollectiveId,
        UserId: payeeUser.id,
        amount: 1000_00,
        currency: 'EUR',
      });

      const fee = await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, expense);

      expect(fee).to.equal(12_00); // EUR domestic cap = €12 (USD cap would be 14_00)
    });

    it('does not cap the fee with a cap expressed in another currency', async () => {
      const host = await fakeHost({ currency: 'HUF', countryISO: 'HU' });
      const payeeUser = await fakeUser({}, { countryISO: 'FR' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payeeUser.CollectiveId,
        UserId: payeeUser.id,
        amount: 10_000_00,
        currency: 'EUR',
      });

      const fee = await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, expense);

      expect(fee).to.equal(70_00); // EUR international cap = €70 (HUF cap would allow €200)
    });

    it('applies JPY caps in cents for zero-decimal currencies', async () => {
      const host = await fakeHost({ currency: 'JPY', countryISO: 'JP' });
      const payeeUser = await fakeUser({}, { countryISO: 'JP' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'JPY' });
      const createJpyExpense = (amount: number) =>
        fakeExpense({
          CollectiveId: collective.id,
          FromCollectiveId: payeeUser.CollectiveId,
          UserId: payeeUser.id,
          amount,
          currency: 'JPY',
        });

      // ¥10,000 => 2% = ¥200, below the ¥1,200 domestic cap
      const smallExpense = await createJpyExpense(10_000_00);
      expect(await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, smallExpense)).to.equal(200_00);

      // ¥1,000,000 => 2% = ¥20,000, capped at ¥1,200
      const largeExpense = await createJpyExpense(1_000_000_00);
      expect(await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, largeExpense)).to.equal(1200_00);
    });

    it('fetches fromCollective when not pre-loaded', async () => {
      const host = await fakeHost({ currency: 'EUR', countryISO: 'DE' });
      const payeeUser = await fakeUser({}, { countryISO: 'DE' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      const expense = await fakeExpense({
        CollectiveId: collective.id,
        FromCollectiveId: payeeUser.CollectiveId,
        UserId: payeeUser.id,
        amount: 10000,
        currency: 'EUR',
      });
      delete expense.fromCollective;

      const fee = await paypalPayouts.estimatePaypalPayoutFeeInExpenseCurrency(host, expense);

      expect(fee).to.equal(200); // 2% of €100 = 200 cents, domestic
    });
  });
});
