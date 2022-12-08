import { expect } from 'chai';
import gql from 'fake-tag';
import nock from 'nock';
import { stub } from 'sinon';

import { ZERO_DECIMAL_CURRENCIES } from '../../../../server/constants/currencies';
import * as constants from '../../../../server/constants/transactions';
import * as paymentsLib from '../../../../server/lib/payments';
import { convertFromStripeAmount, extractFees } from '../../../../server/lib/stripe';
import models from '../../../../server/models';
import * as utils from '../../../utils';

// The GraphQL query that will refund a transaction (it returns the
// transaction being refunded)
const refundTransactionMutation = gql`
  mutation RefundTransaction($id: Int!) {
    refundTransaction(id: $id) {
      id
    }
  }
`;

const snapshotTransactionsForRefund = async transactions => {
  const columns = [
    'type',
    'kind',
    'isRefund',
    'CollectiveId',
    'FromCollectiveId',
    'amount',
    'paymentProcessorFeeInHostCurrency',
    'platformFeeInHostCurrency',
    'netAmountInCollectiveCurrency',
  ];

  await utils.preloadAssociationsForTransactions(transactions, columns);
  utils.snapshotTransactions(transactions, { columns });
};

/**
 * Handles the zero-decimal currencies for Stripe testing; https://stripe.com/docs/currencies#zero-decimal
 */
export const convertToStripeAmount = (currency, amount) => {
  if (ZERO_DECIMAL_CURRENCIES.includes(currency?.toUpperCase())) {
    return amount / 100;
  } else {
    return amount;
  }
};

async function setupTestObjects(currency = 'USD') {
  const user = await models.User.createUserWithCollective(utils.data('user1'));
  const host = await models.User.createUserWithCollective(utils.data('host1'));
  const collective = await models.Collective.create(utils.data('collective1'));
  await collective.addHost(host.collective, host);
  const tier = await models.Tier.create(utils.data('tier1'));
  const paymentMethod = await models.PaymentMethod.create(utils.data('paymentMethod2'));
  await models.ConnectedAccount.create({
    service: 'stripe',
    token: 'sk_test_XOFJ9lGbErcK5akcfdYM1D7j',
    username: 'acct_198T7jD8MNtzsDcg',
    CollectiveId: host.id,
  });
  const order = await models.Order.create({
    description: 'Donation',
    totalAmount: 5000,
    currency: currency,
    TierId: tier.id,
    CreatedByUserId: user.id,
    FromCollectiveId: user.CollectiveId,
    CollectiveId: collective.id,
    PaymentMethodId: paymentMethod.id,
  });
  /* eslint-disable camelcase */
  const charge = {
    id: 'ch_1Bs9ECBYycQg1OMfGIYoPFvk',
    object: 'charge',
    amount: 5000,
    amount_refunded: 0,
    application: 'ca_68FQ4jN0XMVhxpnk6gAptwvx90S9VYXF',
    application_fee: 'fee_1Bs9EEBYycQg1OMfdtHLPqEr',
    balance_transaction: 'txn_1Bs9EEBYycQg1OMfTR33Y5Xr',
    captured: true,
    created: 1517834264,
    currency: currency,
    customer: 'cus_9sKDFZkPwuFAF8',
  };
  const balanceTransaction = {
    id: 'txn_1Bs9EEBYycQg1OMfTR33Y5Xr',
    object: 'balance_transaction',
    amount: convertToStripeAmount(currency, 5000),
    currency: currency,
    fee: convertToStripeAmount(currency, 425),
    fee_details: [
      { amount: convertToStripeAmount(currency, 175), currency: currency, type: 'stripe_fee' },
      { amount: convertToStripeAmount(currency, 250), currency: currency, type: 'application_fee' },
    ],
    net: convertToStripeAmount(currency, 4575),
    status: 'pending',
    type: 'charge',
  };
  /* eslint-enable camelcase */
  const fees = extractFees(balanceTransaction, balanceTransaction.currency);
  const transactionPayload = {
    CreatedByUserId: user.id,
    FromCollectiveId: user.CollectiveId,
    CollectiveId: collective.id,
    PaymentMethodId: paymentMethod.id,
    type: constants.TransactionTypes.CREDIT,
    OrderId: order.id,
    amount: order.totalAmount,
    currency: order.currency,
    hostCurrency: balanceTransaction.currency,
    amountInHostCurrency: convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount),
    hostCurrencyFxRate:
      order.totalAmount / convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount),
    hostFeeInHostCurrency: paymentsLib.calcFee(
      convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount),
      collective.hostFeePercent,
    ),
    platformFeeInHostCurrency: fees.applicationFee,
    paymentProcessorFeeInHostCurrency: fees.stripeFee,
    description: order.description,
    data: { charge, balanceTransaction },
  };
  const transaction = await models.Transaction.createFromContributionPayload(transactionPayload);
  return { user, host, collective, tier, paymentMethod, order, transaction };
}

/* eslint-disable camelcase */
function initStripeNock({ amount, fee, fee_details, net }) {
  const refund = {
    id: 're_1Bvu79LzdXg9xKNSFNBqv7Jn',
    amount: 5000,
    balance_transaction: 'txn_1Bvu79LzdXg9xKNSWEVCLSUu',
  };

  nock('https://api.stripe.com:443').post('/v1/refunds').reply(200, refund);

  nock('https://api.stripe.com:443').get('/v1/balance_transactions/txn_1Bvu79LzdXg9xKNSWEVCLSUu').reply(200, {
    id: 'txn_1Bvu79LzdXg9xKNSWEVCLSUu',
    amount,
    fee,
    fee_details,
    net,
  });

  nock('https://api.stripe.com:443')
    .get('/v1/charges/ch_1Bs9ECBYycQg1OMfGIYoPFvk')
    .reply(200, {
      id: 'ch_1Bs9ECBYycQg1OMfGIYoPFvk',
      amount,
      fee,
      fee_details,
      refunds: {
        object: 'list',
        data: [refund],
      },
    });
}
/* eslint-enable camelcase */

describe('server/graphql/v1/refundTransaction', () => {
  /* All the tests will touch the database, so resetting it is the
   * first thing we do. */
  beforeEach(async () => await utils.resetTestDB());

  it('should gracefully fail when transaction does not exist', async () => {
    // Given that we create a user, host, collective, tier,
    // paymentMethod, an order and a transaction (that we'll ignore)
    const { user } = await setupTestObjects();

    // When a refunded attempt happens on a transaction that does not
    // exist in the database
    const result = await utils.graphqlQuery(refundTransactionMutation, { id: 919191 }, user);

    // Then it should error out with the right error
    const [{ message }] = result.errors;
    expect(message).to.equal('Transaction not found');
  });

  it("should error if user isn't an admin of the host or the creator of the transaction", async () => {
    // Given that we create a user, host, collective, tier,
    // paymentMethod, an order and a transaction
    const { transaction } = await setupTestObjects();

    // And a newly created user
    const anotherUser = await models.User.createUserWithCollective(utils.data('user2'));

    // When a refunded attempt happens from another user
    const result = await utils.graphqlQuery(refundTransactionMutation, { id: transaction.id }, anotherUser);

    // Then it should error out with the right error
    const [{ message }] = result.errors;
    expect(message).to.equal('Cannot refund this transaction');
  });

  describe('Save CreatedByUserId', () => {
    // eslint-disable-next-line camelcase
    beforeEach(() => initStripeNock({ amount: -5000, fee: 0, fee_details: [], net: -5000 }));

    afterEach(nock.cleanAll);

    it('should save the ID of the user that refunded the transaction in CreatedByUserId', async () => {
      // Given that we create a user, host, collective, tier,
      // paymentMethod, an order and a transaction
      const { user, transaction } = await setupTestObjects();

      // And a newly created user that's also a site admin
      const anotherUser = await models.User.createUserWithCollective(utils.data('user3'));

      // When a refunded attempt happens from the above user
      const userStub = stub(anotherUser, 'isRoot').returns(true);
      const result = await utils.graphqlQuery(refundTransactionMutation, { id: transaction.id }, anotherUser);
      userStub.restore();

      // Then there should be no errors
      if (result.errors) {
        throw result.errors;
      }

      // And then all the transactions with that same order id are
      // retrieved.
      const [tr1, tr2, tr3, tr4] = await models.Transaction.findAll({
        where: { OrderId: transaction.OrderId, kind: 'CONTRIBUTION' },
        order: [['id', 'ASC']],
      });

      // And then the first two transactions (related to the order)
      // should be owned by the user created in setupTestObjects()
      expect(tr1.CreatedByUserId).to.equal(user.id);
      expect(tr2.CreatedByUserId).to.equal(user.id);

      // And then the two refund transactions should be owned by the
      // user that refunded the first transactions
      expect(tr3.CreatedByUserId).to.equal(anotherUser.id);
      expect(tr4.CreatedByUserId).to.equal(anotherUser.id);
    });
  }); /* describe("Save CreatedByUserId") */

  /* Stripe will fully refund the processing fee for accounts created
   * prior to 09/17/17. The refunded fee can be seen in the balance
   * transaction call right after a refund.  The nock output isn't
   * complete but we really don't use the other fields retrieved from
   * Stripe. */
  describe('Stripe Transaction - for hosts created before September 17th 2017', () => {
    beforeEach(() =>
      initStripeNock({
        amount: -5000,
        fee: -175,
        fee_details: [{ amount: -175, type: 'stripe_fee' }], // eslint-disable-line camelcase
        net: -4825,
      }),
    );

    afterEach(nock.cleanAll);

    it('should create negative transactions with all the fees refunded', async () => {
      // Given that we create a user, host, collective, tier,
      // paymentMethod, an order and a transaction
      const { user, collective, host, transaction } = await setupTestObjects();

      // Balance pre-refund
      expect(await collective.getBalance()).to.eq(4075);

      // When the above transaction is refunded
      const result = await utils.graphqlQuery(refundTransactionMutation, { id: transaction.id }, host);

      // Then there should be no errors
      if (result.errors) {
        throw result.errors;
      }

      // And then all the transactions with that same order id are
      // retrieved.
      const allTransactions = await models.Transaction.findAll({
        order: [['id', 'ASC']],
        where: { OrderId: transaction.OrderId },
      });

      // Snapshot
      await snapshotTransactionsForRefund(allTransactions);

      // Collective balance should go back to 0
      expect(await collective.getBalance()).to.eq(0);

      // And two new transactions should be created in the
      // database. This only makes sense in an empty database. For
      // order with subscriptions we'd probably find more than 4
      expect(allTransactions.length).to.equal(10);

      // And then the transaction created for the refund operation
      // should decrement all the fees in the CREDIT from collective
      // to user.
      const allContributions = allTransactions.filter(t => t.kind === 'CONTRIBUTION');
      const [tr1, tr2, tr3, tr4] = allContributions;
      const refunds = allTransactions.filter(t => t.isRefund);
      const processorFeeRefund = refunds.find(t => t.kind === 'PAYMENT_PROCESSOR_COVER' && t.type === 'CREDIT');
      const hostFeeRefund = refunds.find(t => t.kind === 'HOST_FEE' && t.type === 'CREDIT');

      // 1. User Ledger
      expect(tr1.type).to.equal('DEBIT');
      expect(tr1.FromCollectiveId).to.equal(collective.id);
      expect(tr1.CollectiveId).to.equal(user.CollectiveId);
      expect(tr1.amount).to.equal(-4575);
      expect(tr1.amountInHostCurrency).to.equal(-4575);
      expect(tr1.platformFeeInHostCurrency).to.equal(-250);
      expect(tr1.hostFeeInHostCurrency).to.equal(0);
      expect(tr1.paymentProcessorFeeInHostCurrency).to.equal(-175);
      expect(tr1.netAmountInCollectiveCurrency).to.equal(-5000);
      expect(tr1.RefundTransactionId).to.equal(tr4.id);

      // 2. Collective Ledger
      expect(tr2.type).to.equal('CREDIT');
      expect(tr2.FromCollectiveId).to.equal(user.CollectiveId);
      expect(tr2.CollectiveId).to.equal(collective.id);
      expect(tr2.amount).to.equal(5000);
      expect(tr2.amountInHostCurrency).to.equal(5000);
      expect(tr2.platformFeeInHostCurrency).to.equal(-250);
      expect(tr2.hostFeeInHostCurrency).to.equal(0);
      expect(tr2.paymentProcessorFeeInHostCurrency).to.equal(-175);
      expect(tr2.netAmountInCollectiveCurrency).to.equal(4575);
      expect(tr2.RefundTransactionId).to.equal(tr3.id);

      // 3. Refund Collective Ledger
      expect(tr3.type).to.equal('DEBIT');
      expect(tr3.FromCollectiveId).to.equal(user.CollectiveId);
      expect(tr3.CollectiveId).to.equal(collective.id);
      expect(tr3.platformFeeInHostCurrency).to.equal(250);
      expect(tr3.hostFeeInHostCurrency).to.equal(0);
      expect(tr3.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(tr3.amount).to.equal(-5000);
      expect(tr3.amountInHostCurrency).to.equal(-5000);
      expect(tr3.netAmountInCollectiveCurrency).to.equal(-4750);
      expect(tr3.RefundTransactionId).to.equal(tr2.id);
      expect(processorFeeRefund).to.exist;
      expect(processorFeeRefund.amount).to.eq(175);
      expect(processorFeeRefund.FromCollectiveId).to.eq(host.id);
      expect(processorFeeRefund.CollectiveId).to.eq(collective.id);
      expect(hostFeeRefund).to.exist;

      // 4. Refund User Ledger
      expect(tr4.type).to.equal('CREDIT');
      expect(tr4.FromCollectiveId).to.equal(collective.id);
      expect(tr4.CollectiveId).to.equal(user.CollectiveId);
      expect(tr4.platformFeeInHostCurrency).to.equal(250);
      expect(tr4.hostFeeInHostCurrency).to.equal(0);
      expect(tr4.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(tr4.netAmountInCollectiveCurrency).to.equal(5000);
      expect(tr4.amount).to.equal(4750);
      expect(tr4.amountInHostCurrency).to.equal(4750);
      expect(tr4.RefundTransactionId).to.equal(tr1.id);
    });
  }); /* describe("Stripe Transaction - for hosts created before September 17th 2017") */

  /* Stripe will not refund the processing fee for accounts created
   * after 09/17/17. The refunded fee will not appear in the balance
   * transaction call right after a refund.  The nock output isn't
   * complete but we really don't use the other fields retrieved from
   * Stripe. */
  describe('Stripe Transaction - for hosts created after September 17th 2017', () => {
    // eslint-disable-next-line camelcase
    beforeEach(() => initStripeNock({ amount: -5000, fee: 0, fee_details: [], net: -5000 }));

    afterEach(nock.cleanAll);

    async function handleRefundTransaction(transaction, host, collective, user) {
      // When the above transaction is refunded
      const result = await utils.graphqlQuery(refundTransactionMutation, { id: transaction.id }, host);

      // Then there should be no errors
      if (result.errors) {
        throw result.errors;
      }

      // And then the returned value should match the transaction
      // passed to the mutation
      expect(result.data.refundTransaction.id).to.equal(transaction.id);

      // And then all the transactions with that same order id are
      // retrieved.
      const allTransactions = await models.Transaction.findAll({
        where: { OrderId: transaction.OrderId },
        order: [['id', 'ASC']],
      });

      // Snapshot
      await snapshotTransactionsForRefund(allTransactions);

      // And two new transactions should be created in the
      // database.  This only makes sense in an empty database. For
      // order with subscriptions we'd probably find more than 4
      expect(allTransactions.length).to.equal(10);

      const allContributions = allTransactions.filter(t => t.kind === 'CONTRIBUTION');
      expect(allContributions.length).to.equal(4);

      // And then the transaction created for the refund operation
      // should decrement all the fees in the CREDIT from collective
      // to user.
      const [tr1, tr2, tr3, tr4] = allContributions;

      // 1. User Ledger
      expect(tr1.type).to.equal('DEBIT');
      expect(tr1.FromCollectiveId).to.equal(collective.id);
      expect(tr1.CollectiveId).to.equal(user.CollectiveId);
      expect(tr1.amount).to.equal(-4575);
      expect(tr1.amountInHostCurrency).to.equal(-4575);
      expect(tr1.platformFeeInHostCurrency).to.equal(-250);
      expect(tr1.hostFeeInHostCurrency).to.equal(0);
      expect(tr1.paymentProcessorFeeInHostCurrency).to.equal(-175);
      expect(tr1.netAmountInCollectiveCurrency).to.equal(-5000);
      expect(tr1.RefundTransactionId).to.equal(tr4.id);

      // 2. Collective Ledger
      expect(tr2.type).to.equal('CREDIT');
      expect(tr2.FromCollectiveId).to.equal(user.CollectiveId);
      expect(tr2.CollectiveId).to.equal(collective.id);
      expect(tr2.amount).to.equal(5000);
      expect(tr2.amountInHostCurrency).to.equal(5000);
      expect(tr2.platformFeeInHostCurrency).to.equal(-250);
      expect(tr2.hostFeeInHostCurrency).to.equal(0);
      expect(tr2.paymentProcessorFeeInHostCurrency).to.equal(-175);
      expect(tr2.netAmountInCollectiveCurrency).to.equal(4575);
      expect(tr2.RefundTransactionId).to.equal(tr3.id);

      // 3. Refund Collective Ledger
      expect(tr3.type).to.equal('DEBIT');
      expect(tr3.FromCollectiveId).to.equal(user.CollectiveId);
      expect(tr3.CollectiveId).to.equal(collective.id);
      expect(tr3.platformFeeInHostCurrency).to.equal(250);
      expect(tr3.hostFeeInHostCurrency).to.equal(0);
      expect(tr3.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(tr3.amount).to.equal(-5000);
      expect(tr3.amountInHostCurrency).to.equal(-5000);
      expect(tr3.netAmountInCollectiveCurrency).to.equal(-4750);
      expect(tr3.RefundTransactionId).to.equal(tr2.id);

      // 4. Refund User Ledger
      expect(tr4.type).to.equal('CREDIT');
      expect(tr4.FromCollectiveId).to.equal(collective.id);
      expect(tr4.CollectiveId).to.equal(user.CollectiveId);
      expect(tr4.platformFeeInHostCurrency).to.equal(250);
      expect(tr4.hostFeeInHostCurrency).to.equal(0);
      expect(tr4.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(tr4.amount).to.equal(4750);
      expect(tr4.amountInHostCurrency).to.equal(4750);
      expect(tr4.netAmountInCollectiveCurrency).to.equal(5000);
      expect(tr4.RefundTransactionId).to.equal(tr1.id);
    }

    it('should create negative transactions without the stripe fee being refunded', async () => {
      // Given that we create a user, host, collective, tier,

      // paymentMethod, an order and a transaction
      const { user, collective, host, transaction } = await setupTestObjects();

      await handleRefundTransaction(transaction, host, collective, user);
    });

    it('should be able to refund a stripe transaction with zero decimal currencies', async () => {
      // Given that we create a user, host, collective, tier,
      // paymentMethod, an order and a transaction
      const { user, collective, host, transaction } = await setupTestObjects('JPY');

      await handleRefundTransaction(transaction, host, collective, user);
    });
  }); /* describe("Stripe Transaction - for hosts created after September 17th 2017") */
}); /* describe("Refund Transaction") */
