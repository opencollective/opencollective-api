import sinon from 'sinon';
import { expect } from 'chai';

import * as paypalbt from '../server/paymentProviders/paypalbt';
import * as utils from './utils';

describe('paypalbt', () => {

  describe('#getOrCreateUserToken', () => {
    let sandbox;

    beforeEach(async () => {
      await utils.resetTestDB();
      sandbox = sinon.sandbox.create();
    });

    afterEach(() => sandbox.restore());

    it('should not call the PayPal API if we have a Customer ID', async () => {
      // Given an order with a customerId on the paymentMethod field
      const order = {
        paymentMethod: { token: 'mytkn', customerId: 'existing-id' },
      };
      // And given that we stub the PayPal API method
      const createCustomerStub = utils.stubPaypalbtCreateCustomer(sandbox, {});

      // When a new user token is needed
      const token = await paypalbt.getOrCreateUserToken(order);

      // Then the returned token should match the payment method token
      expect(token).to.equal('mytkn');

      // And then make sure the PayPal call wasn't executed
      expect(createCustomerStub.called).to.be.false;
    });

    it('should create paypal customer if it does not exist', async () => {
      // Given an order with no customerId on the paymentMethod field
      const order = {
        fromCollective: { name: 'User Making Donation' },
        paymentMethod: { token: 'mytkn', update: sandbox.spy() },
      };
      // And given that the method in PayPal's API is mocked with data
      // of a successful operation of customer creation.
      const createCustomerStub = utils.stubPaypalbtCreateCustomer(sandbox, {
        id: 'new-customer-id',
        paymentMethods: [{ token: 'new-token' }],
      });

      // When a new user token is needed
      const token = await paypalbt.getOrCreateUserToken(order);

      // Then the returned token should match the payment method token
      expect(token).to.equal('mytkn');

      // And then it should have called the stub once
      expect(createCustomerStub.called).to.be.true;
      expect(createCustomerStub.getCall(0).args[0]).to.deep.equal({
        firstName: 'User Making Donation',
        paymentMethodNonce: 'mytkn',
      });
      // And then the spy in the payment method should have been
      // called with the data fed into our stub.
      expect(order.paymentMethod.update.called).to.be.true;
      expect(order.paymentMethod.update.getCall(0).args[0]).to.deep.equal({
        customerId: 'new-customer-id',
        token: 'new-token',
      });
    }); // End of "should create paypal customer if it does not exist"

  }); // End of "#getOrCreateUserToken"

}); // End of "paypalbt"
