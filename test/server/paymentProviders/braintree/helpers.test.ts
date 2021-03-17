import braintree from 'braintree';
import { expect } from 'chai';

import {
  createTransactionsPairFromBraintreeTransaction,
  getCustomerIdFromCollective,
} from '../../../../server/paymentProviders/braintree/helpers';
import { fakeCollective, fakeOrder, fakePaymentMethod } from '../../../test-helpers/fake-data';

describe('server/paymentProviders/braintree/helpers', () => {
  describe('createTransactionsPairFromBraintreeTransaction', () => {
    let paymentMethod, order;
    before(async () => {
      paymentMethod = await fakePaymentMethod({ service: 'braintree', type: 'paypal', token: 'xxxxxx' });
      order = await fakeOrder({ PaymentMethodId: paymentMethod.id });
    });

    it('works with a simple transaction', async () => {
      const transaction = await createTransactionsPairFromBraintreeTransaction(order, <braintree.Transaction>{
        currencyIsoCode: 'EUR',
        amount: '82.66',
      });

      await transaction.validate();
      expect(transaction['amount']).to.eq(8266);
    });

    it('works with platform tips', async () => {
      /* TODO(Braintree) */
    });
  });

  describe('getCustomerIdFromCollective', () => {
    it('returns undefined if no braintree account is available', async () => {
      const collective = await fakeCollective();
      const customerId = await getCustomerIdFromCollective(collective);
      expect(customerId).to.be.undefined;
    });

    it('returns undefined if no customer ID is available', async () => {
      const collective = await fakeCollective();
      await fakePaymentMethod({ CollectiveId: collective.id, service: 'braintree', type: 'paypal', token: 'xxx' });
      const customerId = await getCustomerIdFromCollective(collective);
      expect(customerId).to.be.undefined;
    });

    it('returns the customer ID when available', async () => {
      const collective = await fakeCollective();
      await fakePaymentMethod({
        CollectiveId: collective.id,
        service: 'braintree',
        type: 'paypal',
        token: 'xxx',
        data: { customerId: 'AValidCustomerId' },
      });

      const customerId = await getCustomerIdFromCollective(collective);
      expect(customerId).to.eq('AValidCustomerId');
    });
  });
});
