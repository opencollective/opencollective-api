/* eslint-disable camelcase */
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
import { fakeCollective, fakeHost, fakeOrder, fakePaymentMethod } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

// const application = utils.data('application');

describe('server/paymentProviders/paypal/payment', () => {
  describe('With PayPal auth', () => {
    before(utils.resetTestDB);

    let configStub;
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

      const mockPaypalOrderDetail = ({ amount = '10.00', currency = 'USD', captureStatus = 'COMPLETED' } = {}) => {
        // Catch the retrieval of auth tokens
        nock('https://api.sandbox.paypal.com')
          .persist()
          .post('/v1/oauth2/token')
          .basicAuth({ user: 'my-client-id', pass: 'my-client-secret' })
          .reply(200, { access_token: 'dat-token' }); // eslint-disable-line camelcase

        // Mock the query to get order details
        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .get('/v2/checkout/orders/fake-order-id')
          .reply(200, {
            purchase_units: [{ amount: { value: amount, currency_code: currency } }],
          });

        // Mock the query to trigger the capture
        nock('https://api.sandbox.paypal.com')
          .matchHeader('Authorization', 'Bearer dat-token')
          .post('/v2/checkout/orders/fake-order-id/capture')
          .reply(200, {
            purchase_units: [
              {
                amount: { value: amount, currency_code: currency },
                payments: {
                  captures: [{ id: 'fake-capture-id' }],
                },
              },
            ],
          });

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

      it('Handles nicely the case where the capture succeeds but we somehow fail to ge the details', () => {
        // TODO
      });
    });
  });
});
