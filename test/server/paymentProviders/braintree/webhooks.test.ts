import { expect } from 'chai';
import config from 'config';

import { getBraintreeGatewayForHost } from '../../../../server/paymentProviders/braintree/gateway';
import { braintreeWebhookCallback } from '../../../../server/paymentProviders/braintree/webhooks';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/paymentProviders/braintree/webhooks', () => {
  let host, collectiveWithBraintree, gateway;

  before(async () => {
    await resetTestDB();
    host = await fakeHost();
    collectiveWithBraintree = await fakeCollective({ HostCollectiveId: host.id });
    await fakeConnectedAccount({
      CollectiveId: host.id,
      service: 'braintree',
      username: config.braintree.testGateway.merchantId,
      token: config.braintree.testGateway.privateKey,
      data: { publicKey: config.braintree.testGateway.publicKey },
    });
    gateway = await getBraintreeGatewayForHost(host.id);
  });

  describe('SubscriptionChargedSuccessfully', () => {
    it('Updates the order and record the transactions', async () => {
      const notificationType = 'subscription_charged_successfully';
      const subscriptionId = '42513652';
      const paymentMethod = await fakePaymentMethod({ service: 'braintree', type: 'paypal', token: 'xxxxxx' });
      const order = await fakeOrder({
        status: 'PENDING',
        CollectiveId: collectiveWithBraintree.id,
        PaymentMethodId: paymentMethod.id,
        data: { braintree: { subscriptionId } },
      });

      const notification = gateway.webhookTesting.sampleNotification(notificationType, subscriptionId);
      await braintreeWebhookCallback(host.id, notification.bt_signature, notification.bt_payload);
      await order.reload();
      const transactions = await order.getTransactions();
      const creditTransaction = transactions.find(c => c.type === 'CREDIT');
      const debitTransaction = transactions.find(c => c.type === 'DEBIT');

      expect(order.status).to.eq('ACTIVE');
      expect(transactions.length).to.eq(2);
      await creditTransaction.validate();
      await debitTransaction.validate();
      expect(creditTransaction.amount).to.eq(4999); // default braintree notification amount from https://github.com/braintree/braintree_node/blob/4c525e046b810c18fed5debf6569a64acff30972/lib/braintree/webhook_testing_gateway.js#L374
    });
  });

  // TODO(Braintree): Implement these webhooks

  // describe('SubscriptionChargedUnsuccessfully', () => {});

  // describe('SubscriptionCanceled', () => {
  //   const notificationType = gateway.WebhookNotification.Kind.SubscriptionCanceled;
  // });

  // describe('SubscriptionWentPastDue', () => {
  //   const notificationType = gateway.WebhookNotification.Kind.SubscriptionWentPastDue;
  // });
});
