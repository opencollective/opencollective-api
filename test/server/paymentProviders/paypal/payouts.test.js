/* eslint-disable camelcase */
import crypto from 'crypto';

import { expect } from 'chai';
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
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/paymentProviders/paypal/payouts.js', () => {
  let expense, host, collective, payoutMethod, sandbox;

  beforeEach(async () => {
    await utils.resetTestDB();
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('payExpensesBatch', () => {
    let expense, host, collective, payoutMethod;
    beforeEach(async () => {
      host = await fakeHost({ currency: 'USD' });
      await fakeConnectedAccount({
        CollectiveId: host.id,
        service: 'paypal',
        clientId: 'fake',
        token: 'fake',
      });
      collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
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
      expense.PayoutMethod = payoutMethod;
      sandbox.stub(paypalLib, 'executePayouts').resolves({ batch_header: { payout_batch_id: 'fake' } });
    });

    it('should pay all expenses scheduled for payment', async () => {
      await paypalPayouts.payExpensesBatch([expense]);
      await expense.reload();

      assert.calledOnce(paypalLib.executePayouts);
      expect(expense.data).to.deep.equals({ payout_batch_id: 'fake' });
    });

    it('should generate unique sender_batch_id', async () => {
      await paypalPayouts.payExpensesBatch([expense]);
      const expectedHash = crypto.createHash('SHA1').update(expense.id.toString()).digest('hex');

      expect(paypalLib.executePayouts.firstCall.lastArg)
        .to.have.nested.property('sender_batch_header.sender_batch_id')
        .equals(expectedHash);
    });
  });

  describe('checkBatchStatus', () => {
    beforeEach(async () => {
      host = await fakeCollective({ isHostAccount: true });
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
      paypalLib.getBatchInfo.resolves({
        items: [
          {
            transaction_status: 'SUCCESS',
            payout_item: { sender_item_id: expense.id.toString() },
            payout_batch_id: 'fake-batch-id',
            payout_item_fee: {
              currency: 'USD',
              value: '1.23',
            },
          },
        ],
      });

      await paypalPayouts.checkBatchStatus([expense]);
      const [transaction] = await expense.getTransactions({ where: { type: 'DEBIT' } });

      expect(paypalLib.getBatchInfo.getCall(0)).to.have.property('lastArg', 'fake-batch-id');
      expect(expense).to.have.property('status', 'PAID');
      expect(transaction).to.have.property('paymentProcessorFeeInHostCurrency', -123);
      expect(transaction).to.have.property('netAmountInCollectiveCurrency', -10123);
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

      paypalLib.getBatchInfo.resolves({
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

      expect(paypalLib.getBatchInfo.getCall(0)).to.have.property('lastArg', 'fake-batch-id-eur');
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

      paypalLib.getBatchInfo.resolves({
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

      expect(paypalLib.getBatchInfo.getCall(0)).to.have.property('lastArg', 'fake-batch-id-eur');
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

    const failedStatuses = ['FAILED', 'BLOCKED', 'REFUNDED', 'RETURNED', 'REVERSED'];
    failedStatuses.map(transaction_status =>
      it(`should set expense status to error if the transaction status is ${transaction_status}`, async () => {
        paypalLib.getBatchInfo.resolves({
          items: [
            {
              transaction_status,
              payout_batch_id: 'fake-batch-id',
              payout_item: { sender_item_id: expense.id.toString() },
            },
          ],
        });
        await paypalPayouts.checkBatchStatus([expense]);
        const transactions = await expense.getTransactions({ where: { type: 'DEBIT' } });

        expect(expense).to.have.property('status', 'ERROR');
        expect(transactions).to.have.length(0);
      }),
    );
  });
});
