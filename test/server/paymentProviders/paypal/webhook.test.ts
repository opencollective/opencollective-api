/* eslint-disable camelcase */

import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../server/constants/transactions';
import * as PaypalLib from '../../../../server/lib/paypal';
import * as Sentry from '../../../../server/lib/sentry';
import models from '../../../../server/models';
import Order from '../../../../server/models/Order';
import * as PaypalApi from '../../../../server/paymentProviders/paypal/api';
import paypalWebhook from '../../../../server/paymentProviders/paypal/webhook';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
} from '../../../test-helpers/fake-data';
import { makeGenericRequest, resetTestDB } from '../../../utils';

const createOrderWithSubscription = async (params = {}): Promise<Order> => {
  const paymentMethod = await fakePaymentMethod({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
  });
  return fakeOrder(
    {
      PaymentMethodId: paymentMethod.id,
      subscription: { paypalSubscriptionId: paymentMethod.token },
      ...params,
    },
    { withSubscription: true },
  );
};

type PayPalSubscriptionSaleRefundEventType = 'PAYMENT.SALE.REFUNDED' | 'PAYMENT.SALE.REVERSED';

const PAYPAL_SUBSCRIPTION_SALE_WEBHOOK_CASES: Array<{
  eventType: PayPalSubscriptionSaleRefundEventType;
  buildBody: (saleId: string) => Record<string, unknown>;
}> = [
  {
    eventType: 'PAYMENT.SALE.REFUNDED',
    buildBody: saleId => ({ resource: { sale_id: saleId, transaction_fee: { value: '1.20' } } }),
  },
  {
    eventType: 'PAYMENT.SALE.REVERSED',
    buildBody: saleId => ({ resource: { id: saleId } }),
  },
];

const callPayPalWebhook = (hostId: number, body: Record<string, unknown>) =>
  paypalWebhook(
    makeGenericRequest({
      params: { hostId: String(hostId) },
      body,
    }),
  );

const callPayPalSubscriptionSaleWebhook = (
  hostId: number,
  eventType: PayPalSubscriptionSaleRefundEventType,
  body: Record<string, unknown>,
) => callPayPalWebhook(hostId, { event_type: eventType, ...body });

async function setupPayPalSubscriptionContributionCredit(params: {
  saleId: string;
  amount?: number;
  extraTransactionData?: Record<string, unknown>;
}) {
  const host = await fakeHost();
  await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
  const collective = await fakeCollective({ HostCollectiveId: host.id });
  const order = await createOrderWithSubscription({ CollectiveId: collective.id, status: 'ACTIVE' });
  const originalTransaction = await fakeTransaction(
    {
      type: TransactionTypes.CREDIT,
      kind: TransactionKind.CONTRIBUTION,
      isRefund: false,
      RefundTransactionId: null,
      OrderId: order.id,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      PaymentMethodId: order.PaymentMethodId,
      amount: params.amount ?? 1000,
      data: { paypalCaptureId: params.saleId, ...params.extraTransactionData },
    },
    { createDoubleEntry: true },
  );
  return { host, originalTransaction };
}

describe('server/paymentProviders/paypal/webhook', () => {
  let sandbox;

  before(async () => {
    await resetTestDB();
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('PAYMENT.SALE.COMPLETED', () => {
    const callPaymentSaleCompleted = (hostId: number, body: Record<string, unknown>) =>
      callPayPalWebhook(hostId, { event_type: 'PAYMENT.SALE.COMPLETED', ...body });

    it('ignores if sale is not related to a subscription', async () => {
      const host = await fakeHost();
      await expect(callPaymentSaleCompleted(host.id, { resource: {} })).to.be.fulfilled;
    });

    it('fails if order does not exists', async () => {
      const host = await fakeHost();
      await expect(
        callPaymentSaleCompleted(host.id, { resource: { billing_agreement_id: 'FakeBillingAgreement' } }),
      ).to.be.rejectedWith('No order found for subscription FakeBillingAgreement');
    });

    it('fails if collective has no host', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: null });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      await expect(
        callPaymentSaleCompleted(host.id, { resource: { billing_agreement_id: order.paymentMethod.token } }),
      ).to.be.rejectedWith(`No order found for subscription ${order.paymentMethod.token}`);
    });

    it('fails if host does not have PayPal', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      await expect(
        callPaymentSaleCompleted(host.id, { resource: { billing_agreement_id: order.paymentMethod.token } }),
      ).to.be.rejectedWith(`Host ${host.slug} is not connected to paypal`);
    });

    it('fails if webhook event is invalid', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });

      sandbox.stub(PaypalLib, 'validateWebhookEvent').rejects(new Error('Invalid webhook request'));
      await expect(
        callPaymentSaleCompleted(host.id, { resource: { billing_agreement_id: order.paymentMethod.token } }),
      ).to.be.rejectedWith('Invalid webhook request');
    });

    it('records the sale and activates subscription', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({
        CollectiveId: collective.id,
        status: 'PENDING',
      });

      sandbox.stub(PaypalLib, 'validateWebhookEvent').resolves();
      await callPaymentSaleCompleted(host.id, {
        resource: {
          billing_agreement_id: order.paymentMethod.token,
          amount: { total: '12.00', currency: 'USD' },
          transaction_fee: { value: '1.20', currency: 'USD' },
        },
      });

      const transaction = await models.Transaction.findOne({
        where: { OrderId: order.id, type: 'CREDIT', kind: 'CONTRIBUTION' },
      });
      await models.Transaction.validate(transaction);
      expect(transaction.amount).to.eq(1200);
      expect(transaction.paymentProcessorFeeInHostCurrency).to.eq(-120);
      await order.reload();
      expect(order.status).to.eq('ACTIVE');
    });
  });

  describe('BILLING.SUBSCRIPTION.CANCELLED', () => {
    const callSubscriptionCancelled = (hostId: number, body: Record<string, unknown>) =>
      callPayPalWebhook(hostId, { event_type: 'BILLING.SUBSCRIPTION.CANCELLED', ...body });

    it('succeed if order does not exists, but logs an error to sentry', async () => {
      const host = await fakeHost();
      const stub = sandbox.stub(Sentry, 'reportMessageToSentry');
      await expect(callSubscriptionCancelled(host.id, { resource: { id: 'FakeBillingAgreement' } })).to.be.fulfilled;
      expect(stub).to.have.been.called;
      expect(stub.args[0][0]).to.match(/No order found while cancelling PayPal subscription/);
      expect(stub.args[0][1]).to.deep.eq({
        feature: 'PAYPAL_DONATIONS',
        severity: 'warning',
        extra: {
          body: {
            event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
            resource: { id: 'FakeBillingAgreement' },
          },
        },
      });
    });

    it('succeeds if collective has no host (order not matched for hostId)', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: null });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      const stub = sandbox.stub(Sentry, 'reportMessageToSentry');
      await expect(callSubscriptionCancelled(host.id, { resource: { id: order.paymentMethod.token } })).to.be.fulfilled;
      expect(stub).to.have.been.called;
    });

    it('fails if host does not have PayPal', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      await expect(
        callSubscriptionCancelled(host.id, { resource: { id: order.paymentMethod.token } }),
      ).to.be.rejectedWith(`Host ${host.slug} is not connected to paypal`);
    });

    it('fails if webhook event is invalid', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });

      sandbox.stub(PaypalLib, 'validateWebhookEvent').rejects(new Error('Invalid webhook request'));
      await expect(
        callSubscriptionCancelled(host.id, { resource: { id: order.paymentMethod.token } }),
      ).to.be.rejectedWith('Invalid webhook request');
    });

    it('marks the order as cancelled and stores the reason', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({
        CollectiveId: collective.id,
        status: 'ACTIVE',
      });

      sandbox.stub(PaypalLib, 'validateWebhookEvent').resolves();
      await callSubscriptionCancelled(host.id, {
        resource: {
          id: order.paymentMethod.token,
          status_change_note: 'Cancelling because I received too many potatoes. This is outrageous!',
        },
      });

      await order.reload();
      expect(order.status).to.eq('CANCELLED');
      expect(order.data.paypalStatusChangeNote).to.eq(
        'Cancelling because I received too many potatoes. This is outrageous!',
      );
    });
  });

  describe('PAYMENT.SALE.REFUNDED', () => {
    const callPaymentSaleRefunded = (hostId: number, body: Record<string, unknown>) =>
      callPayPalWebhook(hostId, { event_type: 'PAYMENT.SALE.REFUNDED', ...body });

    it('ignores if resource has no sale_id', async () => {
      const host = await fakeHost();
      await expect(callPaymentSaleRefunded(host.id, { resource: {} })).to.be.fulfilled;
    });

    it('ignores if no transaction matches the sale_id', async () => {
      const host = await fakeHost();
      await expect(callPaymentSaleRefunded(host.id, { resource: { sale_id: 'unknown-sale-id' } })).to.be.fulfilled;
    });

    it('fails if webhook event is invalid', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      const saleId = 'SALE-001';
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          isRefund: false,
          RefundTransactionId: null,
          OrderId: order.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          PaymentMethodId: order.PaymentMethodId,
          data: { paypalCaptureId: saleId },
        },
        {
          createDoubleEntry: true,
        },
      );

      sandbox.stub(PaypalLib, 'validateWebhookEvent').rejects(new Error('Invalid webhook request'));
      await expect(
        callPaymentSaleRefunded(host.id, { resource: { sale_id: saleId, transaction_fee: { value: '1.20' } } }),
      ).to.be.rejectedWith('Invalid webhook request');
    });

    it('creates a refund transaction for the matching sale', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id, status: 'ACTIVE' });
      const saleId = 'SALE-002';
      const originalTransaction = await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          isRefund: false,
          RefundTransactionId: null,
          OrderId: order.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          PaymentMethodId: order.PaymentMethodId,
          amount: 1000,
          data: { paypalCaptureId: saleId },
        },
        {
          createDoubleEntry: true,
        },
      );

      sandbox.stub(PaypalLib, 'validateWebhookEvent').resolves();
      await callPaymentSaleRefunded(host.id, {
        resource: { sale_id: saleId, transaction_fee: { value: '0.50' } },
      });

      const refundTransaction = await models.Transaction.findOne({
        where: { RefundTransactionId: originalTransaction.id },
      });
      expect(refundTransaction).to.exist;
      expect(refundTransaction.data.isRefundedFromPayPal).to.be.true;
    });
  });

  describe('PAYMENT.SALE.REFUNDED / PAYMENT.SALE.REVERSED (shared idempotency)', () => {
    PAYPAL_SUBSCRIPTION_SALE_WEBHOOK_CASES.forEach(({ eventType, buildBody }) => {
      it(`does not validate webhook or create a refund when already refunded from our system (${eventType})`, async () => {
        const saleId = `SHARED-OUR-REFUND-${eventType.replace(/\./g, '-')}`;
        const { host, originalTransaction } = await setupPayPalSubscriptionContributionCredit({
          saleId,
          extraTransactionData: { isRefundedFromOurSystem: true },
        });

        const validateWebhookEventStub = sandbox.stub(PaypalLib, 'validateWebhookEvent').resolves();
        await callPayPalSubscriptionSaleWebhook(host.id, eventType, buildBody(saleId));

        expect(validateWebhookEventStub.called).to.be.false;

        const refundCount = await models.Transaction.count({
          where: { RefundTransactionId: originalTransaction.id },
        });
        expect(refundCount).to.equal(0);
      });

      it(`does not create a second refund when the webhook is redelivered (${eventType})`, async () => {
        const saleId = `SHARED-DUP-WEBHOOK-${eventType.replace(/\./g, '-')}`;
        const { host, originalTransaction } = await setupPayPalSubscriptionContributionCredit({ saleId });

        sandbox.stub(PaypalLib, 'validateWebhookEvent').resolves();
        await callPayPalSubscriptionSaleWebhook(host.id, eventType, buildBody(saleId));

        const refundCountAfterFirst = await models.Transaction.count({
          where: { RefundTransactionId: originalTransaction.id },
        });
        expect(refundCountAfterFirst).to.be.greaterThan(0);

        await callPayPalSubscriptionSaleWebhook(host.id, eventType, buildBody(saleId));

        const refundCountAfterSecond = await models.Transaction.count({
          where: { RefundTransactionId: originalTransaction.id },
        });
        expect(refundCountAfterSecond).to.equal(refundCountAfterFirst);
      });
    });
  });

  describe('PAYMENT.CAPTURE.REVERSED', () => {
    // PayPal sends a Refund object as resource for PAYMENT.CAPTURE.REVERSED (resource_type = "refund"),
    // identical in shape to PAYMENT.CAPTURE.REFUNDED. The handler resolves the original capture via
    // the "up" link in the refund's links array.
    const captureApiBase = 'https://api.sandbox.paypal.com/v2/';

    const makeReversalResource = (refundId: string, captureId: string) => ({
      id: refundId,
      status: 'COMPLETED',
      seller_payable_breakdown: {
        gross_amount: { currency_code: 'USD', value: '15.00' },
        paypal_fee: { currency_code: 'USD', value: '0.00' },
        net_amount: { currency_code: 'USD', value: '15.00' },
        total_refunded_amount: { currency_code: 'USD', value: '15.00' },
      },
      links: [
        { href: `${captureApiBase}payments/refunds/${refundId}`, rel: 'self', method: 'GET' },
        { href: `${captureApiBase}payments/captures/${captureId}`, rel: 'up', method: 'GET' },
      ],
    });

    const callPaymentCaptureReversed = (hostId: number, body: Record<string, unknown>) =>
      callPayPalWebhook(hostId, { event_type: 'PAYMENT.CAPTURE.REVERSED', ...body });

    it('ignores if no transaction matches the capture id resolved from the refund', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      sandbox.stub(PaypalLib, 'validateWebhookEvent').resolves();
      sandbox.stub(PaypalApi, 'paypalRequestV2').callsFake(async url => {
        if (url === 'payments/refunds/REVERSAL-UNKNOWN') {
          return makeReversalResource('REVERSAL-UNKNOWN', 'CAPTURE-UNKNOWN');
        }
        if (url === 'payments/captures/CAPTURE-UNKNOWN') {
          return { id: 'CAPTURE-UNKNOWN', status: 'REFUNDED' };
        }
        throw new Error(`Unexpected: ${url}`);
      });
      await expect(
        callPaymentCaptureReversed(host.id, { resource: makeReversalResource('REVERSAL-UNKNOWN', 'CAPTURE-UNKNOWN') }),
      ).to.be.fulfilled;
    });

    it('creates a refund transaction for the reversed capture', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.PAYPAL,
        type: PAYMENT_METHOD_TYPE.PAYMENT,
      });
      const order = await fakeOrder({ CollectiveId: collective.id, PaymentMethodId: paymentMethod.id });
      const captureId = 'CAPTURE-REV-001';
      const reversalId = 'REVERSAL-REV-001';
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
          amount: 1500,
          data: { paypalCaptureId: captureId },
        },
        { createDoubleEntry: true },
      );

      sandbox.stub(PaypalLib, 'validateWebhookEvent').resolves();
      sandbox.stub(PaypalApi, 'paypalRequestV2').callsFake(async url => {
        if (url === `payments/refunds/${reversalId}`) {
          return makeReversalResource(reversalId, captureId);
        }
        if (url === `payments/captures/${captureId}`) {
          return { id: captureId, status: 'REFUNDED', amount: { currency_code: 'USD', value: '15.00' } };
        }
        throw new Error(`Unexpected PayPal call: ${url}`);
      });

      await callPaymentCaptureReversed(host.id, { resource: makeReversalResource(reversalId, captureId) });

      const refundTransaction = await models.Transaction.findOne({
        where: { RefundTransactionId: originalTransaction.id },
      });
      expect(refundTransaction).to.exist;
      expect(refundTransaction.data.isRefundedFromPayPal).to.be.true;
    });
  });

  describe('PAYMENT.SALE.REVERSED', () => {
    const callPaymentSaleReversed = (hostId: number, body: Record<string, unknown>) =>
      callPayPalWebhook(hostId, { event_type: 'PAYMENT.SALE.REVERSED', ...body });

    it('ignores if no transaction matches the sale id', async () => {
      const host = await fakeHost();
      await expect(callPaymentSaleReversed(host.id, { resource: { id: 'unknown-sale-id' } })).to.be.fulfilled;
    });

    it('ignores when resource.id is missing or falsy', async () => {
      const host = await fakeHost();
      await expect(callPaymentSaleReversed(host.id, {})).to.be.fulfilled;
      await expect(callPaymentSaleReversed(host.id, { resource: {} })).to.be.fulfilled;
      await expect(callPaymentSaleReversed(host.id, { resource: { id: null } })).to.be.fulfilled;
      await expect(callPaymentSaleReversed(host.id, { resource: { id: '' } })).to.be.fulfilled;
    });

    it('fails if webhook event is invalid', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      const saleId = 'SALE-REV-001';
      await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          isRefund: false,
          RefundTransactionId: null,
          OrderId: order.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          PaymentMethodId: order.PaymentMethodId,
          data: { paypalCaptureId: saleId },
        },
        {
          createDoubleEntry: true,
        },
      );

      sandbox.stub(PaypalLib, 'validateWebhookEvent').rejects(new Error('Invalid webhook request'));
      await expect(callPaymentSaleReversed(host.id, { resource: { id: saleId } })).to.be.rejectedWith(
        'Invalid webhook request',
      );
    });

    it('creates a refund transaction for the reversed sale', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id, status: 'ACTIVE' });
      const saleId = 'SALE-REV-002';
      const originalTransaction = await fakeTransaction(
        {
          type: TransactionTypes.CREDIT,
          kind: TransactionKind.CONTRIBUTION,
          isRefund: false,
          RefundTransactionId: null,
          OrderId: order.id,
          CollectiveId: collective.id,
          HostCollectiveId: host.id,
          PaymentMethodId: order.PaymentMethodId,
          amount: 2000,
          data: { paypalCaptureId: saleId },
        },
        {
          createDoubleEntry: true,
        },
      );

      sandbox.stub(PaypalLib, 'validateWebhookEvent').resolves();
      await callPaymentSaleReversed(host.id, { resource: { id: saleId } });

      const refundTransaction = await models.Transaction.findOne({
        where: { RefundTransactionId: originalTransaction.id },
      });
      expect(refundTransaction).to.exist;
      expect(refundTransaction.data.isRefundedFromPayPal).to.be.true;
    });
  });
});
