// Test tools
import { expect } from 'chai';
import * as utils from './utils';

// Code components used for setting up the tests
import models from '../server/models';
import * as constants from '../server/constants/transactions';
import * as stripeGateway from '../server/paymentProviders/stripe/gateway';

// The GraphQL query that will refund a transaction (it returns the
// transaction being refunded)
const refundQuery = `
  mutation refundTransaction($id: Int!) {
    refundTransaction(id: $id) {
      id
    }
  }
`;

async function setupTestObjects() {
  const user = await models.User.createUserWithCollective(utils.data('user1'));
  const host = await models.User.createUserWithCollective(utils.data('host1'));
  const collective = await models.Collective.create(utils.data('collective1'));
  await collective.addHost(host.collective);
  const tier = await models.Tier.create(utils.data('tier1'));
  const paymentMethod = await models.PaymentMethod.create(utils.data('paymentMethod2'));
  const order = await models.Order.create({
    description: 'donation',
    totalAmount: 1000,
    currency: 'USD',
    TierId: tier.id,
    CreatedByUserId: user.id,
    FromCollectiveId: user.CollectiveId,
    CollectiveId: collective.id,
    PaymentMethodId: paymentMethod.id
  });
  const balanceTransaction = {
    "id": "txn_1Bs9EEBYycQg1OMfTR33Y5Xr",
    "object": "balance_transaction",
    "amount": 1000,
    "currency":"usd",
    "fee":119,
    "fee_details": [
      {"amount": 69, "currency":"usd", "type": "stripe_fee"},
      {"amount": 50, "currency": "usd", "type": "application_fee"}
    ],
    "net": 881,
    "status": "pending",
    "type": "charge"
  };

  const charge = {
    "id": "ch_1Bs9ECBYycQg1OMfGIYoPFvk",
    "object": "charge",
    "amount": 1000,
    "amount_refunded": 0,
    "application": "ca_68FQ4jN0XMVhxpnk6gAptwvx90S9VYXF",
    "application_fee": "fee_1Bs9EEBYycQg1OMfdtHLPqEr",
    "balance_transaction": "txn_1Bs9EEBYycQg1OMfTR33Y5Xr",
    "captured": true,
    "created": 1517834264,
    "currency": "usd",
    "customer": "cus_9sKDFZkPwuFAF8"
  };
  const fees = stripeGateway.extractFees(balanceTransaction);
  const hostFeePercent = collective.hostFeePercent;
  const payload = {
    CreatedByUserId: user.id,
    FromCollectiveId: user.CollectiveId,
    CollectiveId: collective.id,
    PaymentMethodId: paymentMethod.id,
    transaction: {
      type: constants.type.CREDIT,
      OrderId: order.id,
      amount: order.totalAmount,
      currency: order.currency,
      hostCurrency: balanceTransaction.currency,
      amountInHostCurrency: balanceTransaction.amount,
      hostCurrencyFxRate: order.totalAmount / balanceTransaction.amount,
      hostFeeInHostCurrency: parseInt(balanceTransaction.amount * hostFeePercent / 100, 10),
      platformFeeInHostCurrency: fees.applicationFee,
      paymentProcessorFeeInHostCurrency: fees.stripeFee,
      description: order.description,
      data: { charge, balanceTransaction }
    }
  };
  const transaction = await models.Transaction.createFromPayload(payload);
  return { user, host, collective, tier, paymentMethod, order, transaction };
}

describe("Refund Transaction", () => {

  describe("Stripe Transaction", () => {
    beforeEach(async () => await utils.resetTestDB());

    it('should create negative transactions if successfuly refunded for the host admin', async () => {
      // Given that we create a user, host, collective, tier,
      // paymentMethod, an order and a transaction
      const { host, transaction } = await setupTestObjects();

      // When the above transaction is refunded
      const result = await utils.graphqlQuery(refundQuery, { id: transaction.id }, host);

      // Then there should be no errors
      if (result.errors) throw result.errors;

      // And then two new transactions should be created in the
      // database
      console.log(await models.Transaction.count());
    });

    it.only('should create negative transactions if successfuly refunded for the user that created the transaction', async () => {
      // Given that we create a user, host, collective, tier,
      // paymentMethod, an order and a transaction
      const { user, transaction } = await setupTestObjects();

      // When the above transaction is refunded
      const result = await utils.graphqlQuery(refundQuery, { id: transaction.id }, user);

      // Then there should be no errors
      if (result.errors) throw result.errors;

      // And then two new transactions should be created in the
      // database
      console.log(await models.Transaction.count());
    });

    it("should error if user isn't an admin of the host or the creator of the transaction", async () => {
      // Given that we create a user, host, collective, tier,
      // paymentMethod, an order and a transaction
      const { transaction } = await setupTestObjects();

      // And a newly created user
      const anotherUser = await models.User.createUserWithCollective(utils.data('user2'));

      // When a refunded attempt happens from another user
      const result = await utils.graphqlQuery(refundQuery, { id: transaction.id }, anotherUser);

      // Then it should error out with the right error
      const [{ message }] = result.errors;
      expect(message).to.equal('Not an admin neither owner');
    });

  });  /* describe("Stripe Transaction") */

});  /* describe("Refund Transaction") */
