/* eslint-disable camelcase */
import * as Sentry from '@sentry/node';
import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { createSandbox, stub } from 'sinon';

import orderStatus from '../../../../server/constants/order-status';
// import request from 'supertest';
// import { v4 as uuid } from 'uuid';
// import app from '../../../../server/index';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import * as SentryLib from '../../../../server/lib/sentry';
import models from '../../../../server/models';
import * as paypalPayment from '../../../../server/paymentProviders/paypal/payment';
import type { PaypalSale, PaypalTransaction } from '../../../../server/types/paypal';
// import * as store from '../../../stores';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

// const application = utils.data('application');

describe('server/paymentProviders/paypal/payment', () => {
  describe('With PayPal auth', () => {
    before(utils.resetTestDB);

    let configStub, authorizePaymentNock;
    before(() => {
      // Stub out the configuration with authentication information and environment name.
      configStub = stub(config.paypal, 'payment').get(() => ({
        environment: 'sandbox',
      }));
    });

    afterEach(() => {
      configStub.restore();
      nock.cleanAll();
    });

    describe('#processOrder', () => {
      let paymentMethod, order, host, collective;
      let metricsCountStub, sentryConfigStub;

      beforeEach(() => {
        sentryConfigStub = stub(config, 'sentry').value({ dsn: 'https://sentry.io/123' });
        metricsCountStub = stub(Sentry.metrics, 'count');
      });

      afterEach(() => {
        sentryConfigStub.restore();
        metricsCountStub.restore();
      });

      const mockPaypalOrderDetail = ({
        amount = '10.00',
        currency = 'USD',
        captureStatus = 'COMPLETED',
        failOnOrderDetails = false,
      } = {}) => {
        // Catch the retrieval of auth tokens
        nock('https://api.sandbox.paypal.com')
          .persist()
          .post('/v1/oauth2/token')
          .basicAuth({ user: 'my-client-id', pass: 'my-client-secret' })
          .reply(200, { access_token: 'dat-token' });

        // Mock the query to get order details
        if (!failOnOrderDetails) {
          nock('https://api.sandbox.paypal.com')
            .matchHeader('Authorization', 'Bearer dat-token')
            .get('/v2/checkout/orders/fake-order-id')
            .reply(200, {
              purchase_units: [{ amount: { value: amount, currency_code: currency } }],
            });
        } else {
          nock('https://api.sandbox.paypal.com')
            .matchHeader('Authorization', 'Bearer dat-token')
            .get('/v2/checkout/orders/fake-order-id')
            .reply(401);
        }

        // Mock the query to authorize the order
        authorizePaymentNock = nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .post('/v2/checkout/orders/fake-order-id/authorize')
          .reply(200, {
            purchase_units: [
              {
                amount: { value: amount, currency_code: currency },
                payments: {
                  authorizations: [{ id: 'fake-authorization-id' }],
                },
              },
            ],
          });

        // Mock the query to trigger the capture
        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .post(`/v2/payments/authorizations/fake-authorization-id/capture`)
          .reply(200, { id: 'fake-capture-id', status: captureStatus });

        // Mock the query to get the capture details
        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .get('/v2/payments/captures/fake-capture-id')
          .reply(200, {
            status: captureStatus,
            amount: { value: amount, currency_code: currency },
            seller_receivable_breakdown: { paypal_fee: { value: '0.00' } },
          });
      };

      before(async () => {
        const secrets = { clientId: 'my-client-id', clientSecret: 'my-client-secret' };
        const paypal = await models.ConnectedAccount.create({
          service: 'paypal',
          clientId: secrets.clientId,
          token: secrets.clientSecret,
        });
        host = await fakeHost();
        await host.addConnectedAccount(paypal);
        collective = await fakeCollective({ HostCollectiveId: host.id });
      });

      beforeEach(async () => {
        paymentMethod = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.PAYPAL,
          type: PAYMENT_METHOD_TYPE.PAYMENT,
          data: { orderId: 'fake-order-id' },
        });

        order = await fakeOrder({
          CollectiveId: collective.id,
          status: orderStatus.NEW,
          PaymentMethodId: paymentMethod.id,
          totalAmount: 1000,
          currency: 'USD',
        });
      });

      it('rejects if bad amount', async () => {
        mockPaypalOrderDetail({ amount: '42.00' });
        await expect(paypalPayment.processOrder(order)).to.be.rejectedWith(
          /The amount\/currency for this payment doesn't match what's expected for this order/,
        );
      });

      it('rejects if bad currency', async () => {
        mockPaypalOrderDetail({ currency: 'EUR' });
        await expect(paypalPayment.processOrder(order)).to.be.rejectedWith(
          /The amount\/currency for this payment doesn't match what's expected for this order/,
        );
      });

      it('Calls PayPal to confirm the order then records the transactions', async () => {
        mockPaypalOrderDetail();
        const transaction = await paypalPayment.processOrder(order);
        expect(transaction).to.exist;
        expect(transaction.amount).to.eq(order.totalAmount);
        expect(order.data.paypalCaptureId).to.equal('fake-capture-id');
        expect(transaction.data.capture).to.deep.eq({
          status: 'COMPLETED',
          amount: { value: '10.00', currency_code: 'USD' },
          seller_receivable_breakdown: { paypal_fee: { value: '0.00' } },
        });
      });

      it('Calls PayPal to confirm the order but does not record the transaction if the capture is not completed', async () => {
        mockPaypalOrderDetail({ captureStatus: 'PENDING' });
        const transaction = await paypalPayment.processOrder(order);
        expect(transaction).to.not.exist;
        expect(order.data.paypalCaptureId).to.equal('fake-capture-id');
      });

      it('records a successful payment outcome metric when the capture completes synchronously', async () => {
        mockPaypalOrderDetail();
        await paypalPayment.processOrder(order);

        expect(metricsCountStub).to.have.been.calledOnce;
        expect(metricsCountStub.firstCall.args).to.deep.equal([
          'thirdparty.paypal.payment.succeeded',
          1,
          { attributes: { flow: 'contribution', method: 'payment' } },
        ]);
      });

      it('does not record the metric when the webhook already recorded the capture', async () => {
        // Simulate the capture-completed webhook winning the race: the transaction already exists,
        // so processOrder reuses it and must not record a second success.
        await fakeTransaction({
          OrderId: order.id,
          type: 'CREDIT',
          kind: TransactionKind.CONTRIBUTION,
          data: { paypalCaptureId: 'fake-capture-id' },
        });
        mockPaypalOrderDetail();

        const transaction = await paypalPayment.processOrder(order);

        expect(transaction).to.exist;
        expect(metricsCountStub.called).to.be.false;
      });

      it('does not record a success metric when the capture is not completed', async () => {
        mockPaypalOrderDetail({ captureStatus: 'PENDING' });
        await paypalPayment.processOrder(order);

        expect(metricsCountStub.called).to.be.false;
      });

      it('Handles nicely the case where the capture succeeds but we somehow fail to get the details', async () => {
        mockPaypalOrderDetail({ failOnOrderDetails: true });
        await expect(paypalPayment.processOrder(order)).to.be.rejectedWith('401');
        expect(authorizePaymentNock.isDone()).to.be.false; // Shouldn't call authorize
      });
    });

    describe('#recordPaypalSale', () => {
      let collective, sandbox, reportMessageStub;

      before(async () => {
        const host = await fakeHost();
        collective = await fakeCollective({ HostCollectiveId: host.id, hostFeePercent: 10 });
      });

      beforeEach(() => {
        sandbox = createSandbox();
        reportMessageStub = sandbox.stub(SentryLib, 'reportMessageToSentry');
      });

      afterEach(() => {
        sandbox.restore();
      });

      const recordSale = (order, total) =>
        paypalPayment.recordPaypalSale(order, {
          id: `SALE-${order.id}`,
          amount: { total, currency: 'USD', details: { subtotal: total } },
          transaction_fee: { value: '0.00', currency: 'USD' },
        } as PaypalSale);

      it('does not warn when the charged amount matches the order', async () => {
        const order = await fakeOrder({ CollectiveId: collective.id, totalAmount: 1000, currency: 'USD' });
        await recordSale(order, '10.00');
        expect(reportMessageStub.called).to.be.false;
      });

      it('warns Sentry when PayPal charged a different amount (https://github.com/opencollective/opencollective/issues/6600)', async () => {
        const order = await fakeOrder({ CollectiveId: collective.id, totalAmount: 500, currency: 'USD' });
        const transaction = await recordSale(order, '10.00');
        expect(transaction.amount).to.eq(1000);
        expect(reportMessageStub.calledOnce).to.be.true;
        const [message, params] = reportMessageStub.firstCall.args;
        expect(message).to.eq('PayPal charged amount does not match the order amount');
        expect(params.severity).to.eq('warning');
        expect(params.extra).to.deep.include({ orderId: order.id, amount: 1000, orderTotalAmount: 500 });
      });
    });

    describe('#recordPaypalTransaction', () => {
      it('records the processor fee in cents', async () => {
        const host = await fakeHost({ currency: 'USD' });
        const collective = await fakeCollective({ HostCollectiveId: host.id });
        const order = await fakeOrder({ CollectiveId: collective.id, totalAmount: 1000, currency: 'USD' });
        const transaction = await paypalPayment.recordPaypalTransaction(order, {
          id: `TXN-${order.id}`,
          amount_with_breakdown: {
            gross_amount: { value: '10.00', currency_code: 'USD' },
            fee_amount: { value: '0.30', currency_code: 'USD' },
          },
        } as PaypalTransaction);
        expect(transaction.paymentProcessorFeeInHostCurrency).to.eq(-30);
      });
    });

    describe('#refundPaypalCapture', () => {
      let host, collective, transaction, user;
      const captureId = 'fake-capture-id';
      const refundId = 'fake-refund-id';

      before(async () => {
        const secrets = { clientId: 'my-client-id', clientSecret: 'my-client-secret' };
        const paypal = await models.ConnectedAccount.create({
          service: 'paypal',
          clientId: secrets.clientId,
          token: secrets.clientSecret,
        });
        host = await fakeHost();
        await host.addConnectedAccount(paypal);
        collective = await fakeCollective({ HostCollectiveId: host.id });
      });

      beforeEach(async () => {
        user = await fakeUser();
        const order = await fakeOrder({ CollectiveId: collective.id });
        transaction = await fakeTransaction(
          {
            CollectiveId: collective.id,
            HostCollectiveId: host.id,
            OrderId: order.id,
            amount: 1000,
            currency: 'USD',
            kind: TransactionKind.CONTRIBUTION,
            data: { paypalCaptureId: captureId },
          },
          { createDoubleEntry: true },
        );

        nock('https://api.sandbox.paypal.com')
          .persist()
          .post('/v1/oauth2/token')
          .basicAuth({ user: 'my-client-id', pass: 'my-client-secret' })
          .reply(200, { access_token: 'dat-token' });

        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .post(`/v2/payments/captures/${captureId}/refund`)
          .reply(200, { id: refundId, status: 'COMPLETED' });

        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .get(`/v2/payments/refunds/${refundId}`)
          .reply(200, {
            id: refundId,
            status: 'COMPLETED',
            seller_payable_breakdown: { paypal_fee: { value: '0.30' } },
          });
      });

      afterEach(() => {
        nock.cleanAll();
      });

      it('records the refund with the new `refund`/`paypalRefundId` fields and preserves original data', async () => {
        const originalTransaction = await paypalPayment.refundPaypalCapture(
          transaction,
          captureId,
          user,
          'Some reason',
        );
        const refundTransaction = await originalTransaction.getRefundTransaction();

        expect(refundTransaction).to.exist;
        expect(refundTransaction.data.paypalRefundId).to.equal(refundId);
        expect(refundTransaction.data.refund).to.deep.include({ id: refundId, status: 'COMPLETED' });
        expect(refundTransaction.data.paypalResponse).to.not.exist;
        // Original transaction data (e.g. paypalCaptureId) must be preserved on the refund transaction
        expect(refundTransaction.data.paypalCaptureId).to.equal(captureId);
        expect(refundTransaction.data.refundReason).to.equal('Some reason');

        // Guarantee MerchantID is consistent between the original transaction and the refund transaction
        expect(refundTransaction.merchantId).to.equal(refundId);
        expect(originalTransaction.merchantId).to.equal(captureId);
      });

      it('converts the refunded PayPal fee from the capture currency to the host currency', async () => {
        const sandbox = createSandbox();
        sandbox.stub(config, 'ledger').value({ ...config.ledger, separatePaymentProcessorFees: true });
        try {
          await utils.seedDefaultVendors();
          const usdHost = await fakeHost({ currency: 'USD' });
          await fakeConnectedAccount({
            CollectiveId: usdHost.id,
            service: 'paypal',
            clientId: 'my-client-id',
            token: 'my-client-secret',
          });
          const eurCollective = await fakeCollective({ HostCollectiveId: usdHost.id, currency: 'EUR' });
          const order = await fakeOrder({ CollectiveId: eurCollective.id, currency: 'EUR', totalAmount: 10000 });

          // 100.00 EUR capture with a 5.00 EUR PayPal fee, recorded on a USD host at a 2.0 rate
          const eurCaptureId = 'fake-eur-capture-id';
          const eurRefundId = 'fake-eur-refund-id';
          const eurTransaction = await models.Transaction.createFromContributionPayload({
            CreatedByUserId: user.id,
            FromCollectiveId: order.FromCollectiveId,
            CollectiveId: eurCollective.id,
            HostCollectiveId: usdHost.id,
            OrderId: order.id,
            type: 'CREDIT',
            amount: 10000,
            currency: 'EUR',
            amountInHostCurrency: 20000,
            hostCurrency: 'USD',
            hostCurrencyFxRate: 2,
            hostFeeInHostCurrency: 0,
            paymentProcessorFeeInHostCurrency: 1000,
            description: 'PayPal contribution',
            data: { paypalCaptureId: eurCaptureId },
          });

          nock('https://api.sandbox.paypal.com')
            .post(`/v2/payments/captures/${eurCaptureId}/refund`)
            .reply(200, { id: eurRefundId, status: 'COMPLETED' });
          nock('https://api.sandbox.paypal.com')
            .get(`/v2/payments/refunds/${eurRefundId}`)
            .reply(200, {
              id: eurRefundId,
              status: 'COMPLETED',
              seller_payable_breakdown: {
                gross_amount: { value: '100.00', currency_code: 'EUR' },
                paypal_fee: { value: '5.00', currency_code: 'EUR' }, // The whole fee, in the capture currency
                net_amount: { value: '95.00', currency_code: 'EUR' },
              },
            });

          await paypalPayment.refundPaypalCapture(eurTransaction, eurCaptureId, user, 'Some reason');

          const feeRefunds = await models.Transaction.findAll({
            where: { OrderId: order.id, kind: TransactionKind.PAYMENT_PROCESSOR_FEE, isRefund: true, type: 'CREDIT' },
          });
          expect(feeRefunds).to.have.length(1);
          expect(feeRefunds[0].amountInHostCurrency).to.eq(1000); // 10.00 USD
          expect(feeRefunds[0].amount).to.eq(500); // 5.00 EUR

          // PayPal returned the whole fee, so the host must not cover any part of it
          const covers = await models.Transaction.findAll({
            where: { OrderId: order.id, kind: TransactionKind.PAYMENT_PROCESSOR_COVER },
          });
          expect(covers).to.have.length(0);
        } finally {
          sandbox.restore();
        }
      });
    });
  });
});
