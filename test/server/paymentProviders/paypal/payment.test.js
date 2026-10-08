/* eslint-disable camelcase */
import * as Sentry from '@sentry/node';
import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { stub } from 'sinon';

// import request from 'supertest';
// import { v4 as uuid } from 'uuid';
// import app from '../../../../server/index';
import models from '../../../../server/models';
import * as paypalPayment from '../../../../server/paymentProviders/paypal/payment';
// import * as store from '../../../stores';
import {
  fakeCollective,
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
          service: 'paypal',
          type: 'payment',
          data: { orderId: 'fake-order-id' },
        });

        order = await fakeOrder({
          CollectiveId: collective.id,
          status: 'NEW',
          PaymentMethodId: paymentMethod.id,
          totalAmount: 1000,
          currency: 'USD',
        });
      });

      it('rejects if bad amount', () => {
        mockPaypalOrderDetail({ amount: '42.00' });
        expect(paypalPayment.processOrder(order)).to.be.rejectedWith(
          /The amount\/currency for this payment doesn't match what's expected for this order/,
        );
      });

      it('rejects if bad currency', () => {
        mockPaypalOrderDetail({ currency: 'EUR' });
        expect(paypalPayment.processOrder(order)).to.be.rejectedWith(
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
          kind: 'CONTRIBUTION',
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

    describe('Bundled PayPal subscription charges (https://github.com/opencollective/opencollective/issues/6600)', () => {
      let host, collective;

      before(async () => {
        host = await fakeHost();
        collective = await fakeCollective({ HostCollectiveId: host.id, hostFeePercent: 10 });
      });

      // Host fees live in separate HOST_FEE transactions (see Transaction.createHostFeeTransactions)
      const getHostFeeCreditAmount = async orderId => {
        const hostFeeTransaction = await models.Transaction.findOne({
          where: { OrderId: orderId, kind: 'HOST_FEE', type: 'CREDIT' },
        });
        return hostFeeTransaction.amount;
      };

      const createPaypalSubscriptionOrder = async (params = {}) => {
        const paymentMethod = await fakePaymentMethod({ service: 'paypal', type: 'subscription' });
        return fakeOrder(
          {
            CollectiveId: collective.id,
            currency: 'USD',
            taxAmount: 0,
            PaymentMethodId: paymentMethod.id,
            subscription: { paypalSubscriptionId: paymentMethod.token },
            ...params,
          },
          { withSubscription: true },
        );
      };

      it('charges single-cycle host fee when amount matches order', async () => {
        const order = await createPaypalSubscriptionOrder({ totalAmount: 1000 });
        const transaction = await paypalPayment.recordPaypalSale(order, {
          id: `SALE-SINGLE-${order.id}`,
          amount: { total: '10.00', currency: 'USD' },
          transaction_fee: { value: '0.00' },
        });
        expect(transaction.amount).to.eq(1000);
        expect(await getHostFeeCreditAmount(order.id)).to.eq(100);
      });

      it('scales host fee when PayPal bundles two cycles in a single charge', async () => {
        const order = await createPaypalSubscriptionOrder({ totalAmount: 500 });
        const transaction = await paypalPayment.recordPaypalSale(order, {
          id: `SALE-BUNDLED-${order.id}`,
          amount: { total: '10.00', currency: 'USD' },
          transaction_fee: { value: '0.00' },
        });
        expect(transaction.amount).to.eq(1000);
        // 10% of the $10 actually charged, not 10% of the $5 order
        expect(await getHostFeeCreditAmount(order.id)).to.eq(100);
      });

      it('reproduces the $5/mo issue example (5.75% host fee)', async () => {
        const collective575 = await fakeCollective({ HostCollectiveId: host.id, hostFeePercent: 5.75 });
        const order = await createPaypalSubscriptionOrder({ CollectiveId: collective575.id, totalAmount: 500 });
        const transaction = await paypalPayment.recordPaypalSale(order, {
          id: `SALE-ISSUE-6600-${order.id}`,
          amount: { total: '10.00', currency: 'USD' },
          transaction_fee: { value: '0.00' },
        });
        expect(transaction.amount).to.eq(1000);
        expect(await getHostFeeCreditAmount(order.id)).to.eq(58);
      });

      it('scales tax and platform tip proportionally for bundled charges', async () => {
        const tipHost = await fakeHost();
        await tipHost.update({ settings: { ...tipHost.settings, newPlatformTipsLedger: true } });
        const tipCollective = await fakeCollective({ HostCollectiveId: tipHost.id, hostFeePercent: 10 });
        const order = await createPaypalSubscriptionOrder({
          CollectiveId: tipCollective.id,
          totalAmount: 1000,
          taxAmount: 100,
          platformTipAmount: 100,
        });
        const transaction = await paypalPayment.recordPaypalSale(order, {
          id: `SALE-TAX-TIP-${order.id}`,
          amount: { total: '20.00', currency: 'USD' },
          transaction_fee: { value: '0.00' },
        });
        expect(transaction.amount).to.eq(1800); // Tip is separated into its own transaction
        expect(transaction.taxAmount).to.eq(-200);
        expect(transaction.data.platformTip).to.eq(200);
        const platformTipTransaction = await models.Transaction.findOne({
          where: { OrderId: order.id, kind: 'PLATFORM_TIP', type: 'CREDIT' },
        });
        expect(platformTipTransaction.amount).to.eq(200);
        // (2000 - 200 - 200) * 10% = 160
        expect(await getHostFeeCreditAmount(order.id)).to.eq(160);
      });

      it('scales host fee for captures of bundled subscription charges', async () => {
        const order = await createPaypalSubscriptionOrder({ totalAmount: 500 });
        const transaction = await paypalPayment.recordPaypalCapture(order, {
          id: `CAPTURE-BUNDLED-${order.id}`,
          amount: { value: '10.00', currency_code: 'USD' },
          seller_receivable_breakdown: { paypal_fee: { value: '0.00' } },
        });
        expect(transaction.amount).to.eq(1000);
        expect(await getHostFeeCreditAmount(order.id)).to.eq(100);
      });

      it('scales host fee for PayPal transactions and records processor fee in cents', async () => {
        const order = await createPaypalSubscriptionOrder({ totalAmount: 500 });
        const transaction = await paypalPayment.recordPaypalTransaction(
          order,
          {
            id: `TXN-BUNDLED-${order.id}`,
            amount_with_breakdown: {
              gross_amount: { value: '10.00', currency_code: 'USD' },
              fee_amount: { value: '0.30' },
            },
          },
          {},
        );
        expect(transaction.amount).to.eq(1000);
        expect(await getHostFeeCreditAmount(order.id)).to.eq(100);
        expect(transaction.paymentProcessorFeeInHostCurrency).to.eq(-30);
      });

      it('keeps the legacy host fee for non-subscription payments', async () => {
        const order = await fakeOrder({
          CollectiveId: collective.id,
          totalAmount: 500,
          currency: 'USD',
          taxAmount: 0,
        });
        const transaction = await paypalPayment.recordPaypalCapture(order, {
          id: `CAPTURE-ONE-TIME-${order.id}`,
          amount: { value: '10.00', currency_code: 'USD' },
          seller_receivable_breakdown: { paypal_fee: { value: '0.00' } },
        });
        expect(transaction.amount).to.eq(1000);
        // Not scaled: the host fee stays on the order amount (10% of $5), not the charged amount
        expect(await getHostFeeCreditAmount(order.id)).to.eq(50);
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
            kind: 'CONTRIBUTION',
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
    });
  });
});
