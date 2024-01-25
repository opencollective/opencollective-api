/* eslint-disable camelcase */

import { expect } from 'chai';
import { Request } from 'express';
import { createSandbox } from 'sinon';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import * as PaypalLib from '../../../../server/lib/paypal';
import * as Sentry from '../../../../server/lib/sentry';
import models from '../../../../server/models';
import { OrderModelInterface } from '../../../../server/models/Order';
import paypalWebhook from '../../../../server/paymentProviders/paypal/webhook';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeSubscription,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const createOrderWithSubscription = async (params = {}): Promise<OrderModelInterface> => {
  const paymentMethod = await fakePaymentMethod({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
  });
  const subscription = await fakeSubscription({ paypalSubscriptionId: paymentMethod.token });
  return fakeOrder(
    {
      PaymentMethodId: paymentMethod.id,
      subscription,
      ...params,
    },
    { withSubscription: true },
  );
};

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
    const callPaymentSaleCompleted = body =>
      paypalWebhook(<Request>{
        body: { event_type: 'PAYMENT.SALE.COMPLETED', ...body },
      });

    it('ignores if sale is not related to a subscription', async () => {
      await expect(callPaymentSaleCompleted({ resource: {} })).to.be.fulfilled;
    });

    it('fails if order does not exists', async () => {
      await expect(
        callPaymentSaleCompleted({ resource: { billing_agreement_id: 'FakeBillingAgreement' } }),
      ).to.be.rejectedWith('No order found for subscription FakeBillingAgreement');
    });

    it('fails if collective has no host', async () => {
      const collective = await fakeCollective({ HostCollectiveId: null });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      await expect(
        callPaymentSaleCompleted({ resource: { billing_agreement_id: order.paymentMethod.token } }),
      ).to.be.rejectedWith(`No host found for collective ${collective.slug}`);
    });

    it('fails if host does not have PayPal', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      await expect(
        callPaymentSaleCompleted({ resource: { billing_agreement_id: order.paymentMethod.token } }),
      ).to.be.rejectedWith(`Host ${host.slug} is not connected to paypal`);
    });

    it('fails if webhook event is invalid', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });

      sandbox.stub(PaypalLib, 'validateWebhookEvent').rejects(new Error('Invalid webhook request'));
      await expect(
        callPaymentSaleCompleted({ resource: { billing_agreement_id: order.paymentMethod.token } }),
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
      await callPaymentSaleCompleted({
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
    const callSubscriptionCancelled = body =>
      paypalWebhook(<Request>{
        body: { event_type: 'BILLING.SUBSCRIPTION.CANCELLED', ...body },
      });

    it('succeed if order does not exists, but logs an error to sentry', async () => {
      const stub = sandbox.stub(Sentry, 'reportMessageToSentry');
      await expect(callSubscriptionCancelled({ resource: { id: 'FakeBillingAgreement' } })).to.be.fulfilled;
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

    it('fails if collective has no host', async () => {
      const collective = await fakeCollective({ HostCollectiveId: null });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      await expect(callSubscriptionCancelled({ resource: { id: order.paymentMethod.token } })).to.be.rejectedWith(
        `No host found for collective ${collective.slug}`,
      );
    });

    it('fails if host does not have PayPal', async () => {
      const host = await fakeHost();
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });
      await expect(callSubscriptionCancelled({ resource: { id: order.paymentMethod.token } })).to.be.rejectedWith(
        `Host ${host.slug} is not connected to paypal`,
      );
    });

    it('fails if webhook event is invalid', async () => {
      const host = await fakeHost();
      await fakeConnectedAccount({ CollectiveId: host.id, service: 'paypal', token: 'xxxxxx' });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      const order = await createOrderWithSubscription({ CollectiveId: collective.id });

      sandbox.stub(PaypalLib, 'validateWebhookEvent').rejects(new Error('Invalid webhook request'));
      await expect(callSubscriptionCancelled({ resource: { id: order.paymentMethod.token } })).to.be.rejectedWith(
        'Invalid webhook request',
      );
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
      await callSubscriptionCancelled({
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
});
