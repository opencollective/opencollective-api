/* eslint-disable camelcase */

import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import { run } from '../../../cron/daily/51-synchronize-paypal-ledger';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../server/constants/transactions';
import * as PaymentsLib from '../../../server/lib/payments';
import * as PaypalLib from '../../../server/lib/paypal';
import * as SentryLib from '../../../server/lib/sentry';
import models from '../../../server/models';
import * as PaypalApi from '../../../server/paymentProviders/paypal/api';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
} from '../../test-helpers/fake-data';
import { resetTestDB, seedDefaultVendors } from '../../utils';

describe('cron/daily/51-synchronize-paypal-ledger', () => {
  let sandbox;

  before(async () => {
    await resetTestDB();
  });

  beforeEach(() => {
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  /** Create a host with a PayPal connected account and stub getHostsWithPayPalConnected */
  const setupHost = async () => {
    const host = await fakeHost();
    await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'test-paypal-token' });
    sandbox.stub(PaypalLib, 'getHostsWithPayPalConnected').resolves([host]);
    return host;
  };

  /**
   * Build a minimal stub for listPayPalTransactions.
   * Pass `refundId` to also include a T1107 refund event referencing `captureId`.
   * Pass `reversalId` to include a T1106 PayPal-initiated reversal event referencing `captureId`.
   */
  const stubListTransactions = (captureId: string, eventCode = 'T0006', refundId?: string, reversalId?: string) => {
    const transactions: object[] = [
      {
        transaction_info: {
          transaction_id: captureId,
          transaction_event_code: eventCode,
          transaction_amount: { value: '10.00', currency_code: 'USD' },
        },
      },
    ];

    if (refundId) {
      transactions.push({
        transaction_info: {
          transaction_id: refundId,
          transaction_event_code: 'T1107',
          paypal_reference_id: captureId,
          paypal_reference_id_type: 'TXN',
          transaction_amount: { value: '-10.00', currency_code: 'USD' },
        },
      });
    }

    if (reversalId) {
      transactions.push({
        transaction_info: {
          transaction_id: reversalId,
          transaction_event_code: 'T1106',
          paypal_reference_id: captureId,
          paypal_reference_id_type: 'TXN',
          transaction_amount: { value: '-10.00', currency_code: 'USD' },
        },
      });
    }

    sandbox.stub(PaypalLib, 'listPayPalTransactions').resolves({
      transactions,
      currentPage: 1,
      totalPages: 1,
      fullResponse: { total_items: transactions.length },
    });
  };

  describe('getMissingRefundTransactions', () => {
    it('records a missing refund when PayPal marks a capture as REFUNDED', async () => {
      const host = await setupHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.PAYPAL,
        type: PAYMENT_METHOD_TYPE.PAYMENT,
      });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });
      const captureId = 'CAPTURE-REFUNDED-001';

      const originalTransaction = await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          isRefund: false,
          RefundTransactionId: null,
          OrderId: order.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          PaymentMethodId: paymentMethod.id,
          amount: 1000,
          paymentProcessorFeeInHostCurrency: -50,
          data: { paypalCaptureId: captureId },
        },
        { createDoubleEntry: true },
      );

      // T1107 event in the list tells us directly that REFUND-001 is the refund ID
      stubListTransactions(captureId, 'T0006', 'REFUND-001');

      sandbox.stub(PaypalApi, 'paypalRequestV2').callsFake(async url => {
        if (url === 'payments/refunds/REFUND-001') {
          return {
            id: 'REFUND-001',
            status: 'COMPLETED',
            seller_payable_breakdown: {
              paypal_fee: { value: '0.50', currency_code: 'USD' },
              total_refunded_amount: { value: '10.00', currency_code: 'USD' },
            },
          };
        }
        throw new Error(`Unexpected PayPal API call: ${url}`);
      });

      await run();

      // The refund transaction should have been created and linked back to the original
      const refundTransaction = await models.Transaction.findOne({
        where: { RefundTransactionId: originalTransaction.id },
      });
      expect(refundTransaction, 'refund transaction should exist').to.exist;
      expect(refundTransaction.isRefund).to.be.true;
      expect((refundTransaction.data as Record<string, unknown>).isRefundedFromPayPal).to.be.true;

      // The original transaction should now point to its refund
      await originalTransaction.reload();
      expect(originalTransaction.RefundTransactionId).to.not.be.null;
    });

    it('converts the refunded PayPal fee from the capture currency to the host currency', async () => {
      await seedDefaultVendors();
      sandbox.stub(config, 'ledger').value({ ...config.ledger, separatePaymentProcessorFees: true });
      const host = await setupHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.PAYPAL,
        type: PAYMENT_METHOD_TYPE.PAYMENT,
      });
      const order = await fakeOrder({
        CollectiveId: collective.id,
        PaymentMethodId: paymentMethod.id,
        currency: 'EUR',
      });
      const captureId = 'CAPTURE-REFUNDED-EUR-001';

      // 10.00 EUR capture with a 1.00 EUR PayPal fee, recorded on a USD host at a 1.1 rate
      await models.Transaction.createFromContributionPayload({
        CreatedByUserId: order.CreatedByUserId,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        OrderId: order.id,
        PaymentMethodId: paymentMethod.id,
        type: TransactionTypes.CREDIT,
        amount: 1000,
        currency: 'EUR',
        amountInHostCurrency: 1100,
        hostCurrency: 'USD',
        hostCurrencyFxRate: 1.1,
        hostFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 110,
        description: 'PayPal contribution',
        data: { paypalCaptureId: captureId },
      });

      stubListTransactions(captureId, 'T0006', 'REFUND-EUR-001');
      sandbox.stub(PaypalApi, 'paypalRequestV2').callsFake(async url => {
        if (url === 'payments/refunds/REFUND-EUR-001') {
          return {
            id: 'REFUND-EUR-001',
            status: 'COMPLETED',
            seller_payable_breakdown: {
              paypal_fee: { value: '1.00', currency_code: 'EUR' }, // The whole fee, in the capture currency
              total_refunded_amount: { value: '10.00', currency_code: 'EUR' },
            },
          };
        }
        throw new Error(`Unexpected PayPal API call: ${url}`);
      });

      await run();

      const feeRefunds = await models.Transaction.findAll({
        where: { OrderId: order.id, kind: TransactionKind.PAYMENT_PROCESSOR_FEE, isRefund: true, type: 'CREDIT' },
      });
      expect(feeRefunds).to.have.length(1);
      expect(feeRefunds[0].amountInHostCurrency).to.eq(110); // 1.10 USD
      expect(feeRefunds[0].amount).to.eq(100); // 1.00 EUR

      // PayPal returned the whole fee, so the host must not cover any part of it
      const covers = await models.Transaction.findAll({
        where: { OrderId: order.id, kind: TransactionKind.PAYMENT_PROCESSOR_COVER },
      });
      expect(covers).to.have.length(0);
    });

    it('records a missing reversal when PayPal marks a capture as reversed (T1106)', async () => {
      const host = await setupHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.PAYPAL,
        type: PAYMENT_METHOD_TYPE.PAYMENT,
      });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });
      const captureId = 'CAPTURE-REVERSED-001';

      const originalTransaction = await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          isRefund: false,
          RefundTransactionId: null,
          OrderId: order.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          PaymentMethodId: paymentMethod.id,
          amount: 1000,
          paymentProcessorFeeInHostCurrency: -50,
          data: { paypalCaptureId: captureId },
        },
        { createDoubleEntry: true },
      );

      stubListTransactions(captureId, 'T0006', undefined, 'REVERSAL-001');

      // T1106 transaction_id is the PayPal refund/reversal ID, queryable via payments/refunds/
      sandbox.stub(PaypalApi, 'paypalRequestV2').callsFake(async url => {
        if (url === 'payments/refunds/REVERSAL-001') {
          return {
            id: 'REVERSAL-001',
            status: 'COMPLETED',
            seller_payable_breakdown: {
              paypal_fee: { value: '0.00', currency_code: 'USD' },
              total_refunded_amount: { value: '10.00', currency_code: 'USD' },
            },
          };
        }
        throw new Error(`Unexpected PayPal API call: ${url}`);
      });

      await run();

      const refundTransaction = await models.Transaction.findOne({
        where: { RefundTransactionId: originalTransaction.id },
      });
      expect(refundTransaction, 'reversal transaction should exist').to.exist;
      expect(refundTransaction.isRefund).to.be.true;
      expect((refundTransaction.data as Record<string, unknown>).isRefundedFromPayPal).to.be.true;

      await originalTransaction.reload();
      expect(originalTransaction.RefundTransactionId).to.not.be.null;
    });

    it('makes no API calls and skips when no T1107 refund event is in the PayPal transaction list', async () => {
      const host = await setupHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const paymentMethod = await fakePaymentMethod({ service: PAYMENT_METHOD_SERVICE.PAYPAL });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });
      const captureId = 'CAPTURE-COMPLETED-001';

      const originalTransaction = await fakeTransaction({
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        isRefund: false,
        RefundTransactionId: null,
        OrderId: order.id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PaymentMethodId: paymentMethod.id,
        amount: 500,
        data: { paypalCaptureId: captureId },
      });

      // No T1107 in the list — the function should return early without calling PayPal
      stubListTransactions(captureId);
      const paypalStub = sandbox.stub(PaypalApi, 'paypalRequestV2');

      await run();

      expect(paypalStub.called, 'no PayPal API call should be made').to.be.false;
      await originalTransaction.reload();
      expect(originalTransaction.RefundTransactionId).to.be.null;
    });

    it('skips transactions that already have a RefundTransactionId', async () => {
      const host = await setupHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const paymentMethod = await fakePaymentMethod({ service: PAYMENT_METHOD_SERVICE.PAYPAL });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });
      const captureId = 'CAPTURE-ALREADY-REFUNDED-001';

      // Create a fake "refund" transaction to act as the existing refund
      const existingRefund = await fakeTransaction({ isRefund: true, CollectiveId: collective.id });

      const originalTransaction = await fakeTransaction({
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        isRefund: false,
        RefundTransactionId: existingRefund.id, // already refunded
        OrderId: order.id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PaymentMethodId: paymentMethod.id,
        amount: 800,
        data: { paypalCaptureId: captureId },
      });

      stubListTransactions(captureId);

      const paypalStub = sandbox.stub(PaypalApi, 'paypalRequestV2');

      await run();

      // No T1107 in the list AND the DB query filters RefundTransactionId IS NULL,
      // so no PayPal API call should be made.
      expect(paypalStub.called).to.be.false;
      expect(originalTransaction.RefundTransactionId).to.equal(existingRefund.id);
    });

    it('skips and does not record a refund when PayPal indicates a partial refund', async () => {
      const host = await setupHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const paymentMethod = await fakePaymentMethod({ service: PAYMENT_METHOD_SERVICE.PAYPAL });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });
      const captureId = 'CAPTURE-PARTIAL-001';

      const originalTransaction = await fakeTransaction({
        type: TransactionTypes.CREDIT,
        kind: TransactionKind.CONTRIBUTION,
        isRefund: false,
        RefundTransactionId: null,
        OrderId: order.id,
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        PaymentMethodId: paymentMethod.id,
        amount: 1000, // $10.00
        paymentProcessorFeeInHostCurrency: -50, // $0.50 fee → net = $9.50
        data: { paypalCaptureId: captureId },
      });

      // T1107 event points directly to the refund ID
      stubListTransactions(captureId, 'T0006', 'REFUND-PARTIAL-001');

      sandbox.stub(PaypalApi, 'paypalRequestV2').callsFake(async url => {
        if (url === 'payments/refunds/REFUND-PARTIAL-001') {
          return {
            id: 'REFUND-PARTIAL-001',
            status: 'COMPLETED',
            seller_payable_breakdown: {
              paypal_fee: { value: '0.25', currency_code: 'USD' },
              // Only $3.00 refunded out of $10.00 → clearly partial
              total_refunded_amount: { value: '3.00', currency_code: 'USD' },
            },
          };
        }
        throw new Error(`Unexpected PayPal API call: ${url}`);
      });

      // The cron job reports to Sentry and skips partial refunds rather than throwing
      await expect(run()).to.be.fulfilled;

      // No refund transaction should have been created
      await originalTransaction.reload();
      expect(originalTransaction.RefundTransactionId).to.be.null;
    });

    it('keeps syncing other hosts when recording a refund fails for one host', async () => {
      const setupRefundedContribution = async (captureId: string) => {
        const host = await fakeHost();
        await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'test-paypal-token' });
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const paymentMethod = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.PAYPAL,
          type: PAYMENT_METHOD_TYPE.PAYMENT,
        });
        const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });
        const transaction = await fakeTransaction(
          {
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            isRefund: false,
            RefundTransactionId: null,
            OrderId: order.id,
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            PaymentMethodId: paymentMethod.id,
            amount: 1000,
            paymentProcessorFeeInHostCurrency: -50,
            data: { paypalCaptureId: captureId },
          },
          { createDoubleEntry: true },
        );
        return { host, transaction };
      };

      const hostA = await setupRefundedContribution('CAPTURE-ISOLATION-A');
      const hostB = await setupRefundedContribution('CAPTURE-ISOLATION-B');
      sandbox.stub(PaypalLib, 'getHostsWithPayPalConnected').resolves([hostA.host, hostB.host]);
      sandbox.stub(PaypalLib, 'listPayPalTransactions').callsFake(async host => {
        const captureId = host.id === hostA.host.id ? 'CAPTURE-ISOLATION-A' : 'CAPTURE-ISOLATION-B';
        const transactions = [
          { transaction_info: { transaction_id: captureId, transaction_event_code: 'T0006' } },
          {
            transaction_info: {
              transaction_id: `REFUND-${captureId}`,
              transaction_event_code: 'T1107',
              paypal_reference_id: captureId,
              paypal_reference_id_type: 'TXN',
            },
          },
        ];
        return { transactions, currentPage: 1, totalPages: 1, fullResponse: { total_items: transactions.length } };
      });

      sandbox.stub(PaypalApi, 'paypalRequestV2').callsFake(async url => {
        if (url.startsWith('payments/refunds/')) {
          return {
            id: url.split('/').pop(),
            status: 'COMPLETED',
            seller_payable_breakdown: {
              paypal_fee: { value: '0.00', currency_code: 'USD' },
              total_refunded_amount: { value: '10.00', currency_code: 'USD' },
            },
          };
        }
        throw new Error(`Unexpected PayPal API call: ${url}`);
      });

      // Simulate a webhook recording host A's refund first: createRefundTransaction throws for it
      const originalCreateRefundTransaction = PaymentsLib.createRefundTransaction;
      sandbox
        .stub(PaymentsLib, 'createRefundTransaction')
        .callsFake(async (transaction, refundedPaymentProcessorFee, data, user) => {
          if (transaction.id === hostA.transaction.id) {
            throw new Error('This transaction has already been refunded');
          }
          return originalCreateRefundTransaction(transaction, refundedPaymentProcessorFee, data, user);
        });
      const reportErrorToSentry = sandbox.stub(SentryLib, 'reportErrorToSentry');

      await expect(run()).to.be.fulfilled;

      // The error is reported, and host B's refund is still recorded
      expect(reportErrorToSentry.calledOnce).to.be.true;
      expect(reportErrorToSentry.firstCall.args[0].message).to.eq('This transaction has already been refunded');
      const refundTransaction = await models.Transaction.findOne({
        where: { RefundTransactionId: hostB.transaction.id },
      });
      expect(refundTransaction, 'host B refund transaction should exist').to.exist;
    });
  });
});
