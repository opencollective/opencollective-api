import { expect } from 'chai';
import gql from 'fake-tag';
import { pick } from 'lodash';
import nock from 'nock';
import { createSandbox } from 'sinon';
import Stripe from 'stripe';

import { SupportedCurrency } from '../../../../../server/constants/currencies';
import MemberRoles from '../../../../../server/constants/roles';
import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import { TransactionTypes } from '../../../../../server/constants/transactions';
import * as TransactionMutationHelpers from '../../../../../server/graphql/common/transactions';
import emailLib from '../../../../../server/lib/email';
import { calcFee, executeOrder } from '../../../../../server/lib/payments';
import stripe, { convertFromStripeAmount, convertToStripeAmount, extractFees } from '../../../../../server/lib/stripe';
import models from '../../../../../server/models';
import stripeMocks from '../../../../mocks/stripe';
import { fakeCollective, fakeOrder, fakeTransaction, fakeUser, randStr } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

const STRIPE_TOKEN = 'tok_123456781234567812345678';

const refundTransactionMutation = gql`
  mutation RefundTransaction($transaction: TransactionReferenceInput!) {
    refundTransaction(transaction: $transaction) {
      id
      legacyId
    }
  }
`;

describe('server/graphql/v2/mutation/TransactionMutations', () => {
  let sandbox,
    collectiveAdminUser,
    hostAdminUser,
    randomUser,
    collective,
    order1,
    order2,
    transaction1,
    transaction2,
    sendEmailSpy,
    refundTransactionSpy;

  before(async () => {
    await utils.resetTestDB();
    await utils.seedDefaultVendors();
  });

  before(() => {
    sandbox = createSandbox();
    sandbox.stub(stripe.customers, 'create').callsFake(() => Promise.resolve({ id: 'cus_BM7mGwp1Ea8RtL' }));
    sandbox.stub(stripe.customers, 'retrieve').callsFake(() => Promise.resolve({ id: 'cus_BM7mGwp1Ea8RtL' }));
    sandbox.stub(stripe.tokens, 'create').callsFake(() => Promise.resolve({ id: 'tok_1AzPXGD8MNtzsDcgwaltZuvp' }));
    sandbox.stub(stripe.paymentIntents, 'create').callsFake(() =>
      Promise.resolve({
        id: 'pi_1F82vtBYycQg1OMfS2Rctiau',
        status: 'requires_confirmation',
      }),
    );
    sandbox.stub(stripe.paymentIntents, 'confirm').callsFake(() =>
      Promise.resolve({
        charges: { data: [{ id: 'ch_1AzPXHD8MNtzsDcgXpUhv4pm' }] },
        status: 'succeeded',
      }),
    );
    sandbox.stub(stripe.balanceTransactions, 'retrieve').callsFake(() => Promise.resolve(stripeMocks.balance));
    sandbox.stub(stripe.refunds, 'create').callsFake(() => Promise.resolve('foo'));
    sandbox.stub(stripe.charges, 'retrieve').callsFake(() => Promise.resolve('foo'));

    sandbox
      .stub(stripe.paymentMethods, 'create')
      .callsFake(() => Promise.resolve({ id: randStr('pm_'), type: 'card', card: { fingerprint: 'fingerprint' } }));
    sandbox
      .stub(stripe.paymentMethods, 'attach')
      .callsFake(id => Promise.resolve({ id, type: 'card', card: { fingerprint: 'fingerprint' } }));

    sendEmailSpy = sandbox.spy(emailLib, 'send');
    refundTransactionSpy = sandbox.spy(TransactionMutationHelpers, 'refundTransaction');
  });

  after(() => sandbox.restore());

  before(async () => {
    collectiveAdminUser = await fakeUser();
    hostAdminUser = await fakeUser();
    randomUser = await fakeUser();
    collective = await fakeCollective();
    await collective.addUserWithRole(collectiveAdminUser, 'ADMIN');
    await collective.host.addUserWithRole(hostAdminUser, 'ADMIN');
    await collectiveAdminUser.populateRoles();
    await hostAdminUser.populateRoles();
    order1 = await fakeOrder({
      CollectiveId: collective.id,
      totalAmount: stripeMocks.balance.amount,
    });
    order1 = await order1.setPaymentMethod({ token: STRIPE_TOKEN });
    order2 = await fakeOrder({
      CollectiveId: collective.id,
      totalAmount: stripeMocks.balance.amount,
    });
    order2 = await order2.setPaymentMethod({ token: STRIPE_TOKEN });
    await models.ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      CollectiveId: collective.host.id,
    });
    await executeOrder(randomUser, order1);
    transaction1 = await models.Transaction.findOne({
      where: {
        OrderId: order1.id,
        type: 'CREDIT',
        kind: 'CONTRIBUTION',
      },
    });
    await executeOrder(randomUser, order2);
    transaction2 = await models.Transaction.findOne({
      where: {
        OrderId: order2.id,
        type: 'CREDIT',
        kind: 'CONTRIBUTION',
      },
    });
    await models.Member.create({
      CollectiveId: collective.id,
      MemberCollectiveId: randomUser.id,
      role: MemberRoles.BACKER,
      CreatedByUserId: randomUser.id,
    });
  });

  afterEach(() => {
    refundTransactionSpy.resetHistory();
  });

  describe('refundTransaction', () => {
    it('should gracefully fail when transaction does not exist', async () => {
      const result = await graphqlQueryV2(refundTransactionMutation, { transaction: { legacyId: -1 } }, hostAdminUser);
      const [{ message }] = result.errors;
      expect(message).to.equal('Transaction not found');
    });

    it("should error if user isn't logged in", async () => {
      const transaction = { legacyId: transaction1.id };
      const result = await graphqlQueryV2(refundTransactionMutation, { transaction }, null);
      const [{ message }] = result.errors;
      expect(message).to.equal('You need to be logged in to manage transactions.');
    });

    it("should error if user isn't allowed", async () => {
      const transaction = { legacyId: transaction1.id };
      const result = await graphqlQueryV2(refundTransactionMutation, { transaction }, randomUser);
      const [{ message }] = result.errors;
      expect(message).to.equal('Cannot refund this transaction');
    });

    it('refunds the transaction', async () => {
      const result = await graphqlQueryV2(
        refundTransactionMutation,
        { transaction: { legacyId: transaction1.id } },
        hostAdminUser,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.refundTransaction.id).to.exist;

      // And then all the transactions with that same order id are retrieved.
      const [refund1, refund2] = await models.Transaction.findAll({
        where: { OrderId: transaction1.OrderId, kind: 'CONTRIBUTION', isRefund: true },
        order: [['id', 'ASC']],
      });

      // And then the two refund transactions should be owned by the
      // user that refunded the first transactions
      expect(refund1.CreatedByUserId).to.equal(hostAdminUser.id);
      expect(refund2.CreatedByUserId).to.equal(hostAdminUser.id);
    });

    it('error if the collective does not have enough funds', async () => {
      const result = await graphqlQueryV2(
        refundTransactionMutation,
        { transaction: { legacyId: transaction1.id } },
        hostAdminUser,
      );
      const [{ message }] = result.errors;
      expect(message).to.equal('Not enough funds to refund this transaction');
    });
  });

  describe('rejectTransaction', () => {
    const rejectTransactionMutation = gql`
      mutation RejectTransaction($transaction: TransactionReferenceInput!, $message: String) {
        rejectTransaction(transaction: $transaction, message: $message) {
          id
        }
      }
    `;

    it('should not refund the transaction if it has already been refunded but not rejected', async () => {
      await graphqlQueryV2(
        rejectTransactionMutation,
        {
          transaction: { legacyId: transaction1.id },
        },
        collectiveAdminUser,
      );

      expect(refundTransactionSpy.notCalled).to.be.true;
    });

    it('does not allow random user to reject', async () => {
      const result = await graphqlQueryV2(
        rejectTransactionMutation,
        {
          transaction: { legacyId: transaction2.id },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.match(/Cannot reject this transaction/);
    });

    it('rejects the transaction', async () => {
      // Add funds to the collective
      await fakeTransaction({
        ...pick(transaction1, ['CollectiveId', 'HostCollectiveId', 'amount', 'amountInHostCurrency', 'currency']),
        kind: TransactionKind.ADDED_FUNDS,
      });
      const message = 'We do not want your contribution';
      const result = await graphqlQueryV2(
        rejectTransactionMutation,
        {
          transaction: { legacyId: transaction2.id },
          message,
        },
        hostAdminUser,
      );

      const updatedOrder = await models.Order.findOne({
        where: { id: order2.id },
      });

      const memberships = await models.Member.findOne({
        where: {
          MemberCollectiveId: transaction2.FromCollectiveId,
          CollectiveId: transaction2.CollectiveId,
          role: 'BACKER',
        },
      });

      await utils.waitForCondition(() => sendEmailSpy.calledWith('contribution.rejected'));

      expect(result.errors).to.not.exist;
      expect(result.data.rejectTransaction.id).to.exist;
      expect(sendEmailSpy.calledWith('contribution.rejected')).to.be.true;
      expect(updatedOrder.status).to.eq('REJECTED');
      expect(memberships).to.be.null;
    });
  });
});

describe('refundTransaction legacy tests', () => {
  // The tests here are a portage of what we had in `test/server/graphql/v1/refundTransaction.test.js`
  // They're not set up with the best practices but are still important to keep, so we've isolated them
  // in this describe block.

  /* eslint-disable camelcase */
  function initStripeNock({ amount, fee, fee_details, net }) {
    const refund = {
      id: 're_1Bvu79LzdXg9xKNSFNBqv7Jn',
      amount,
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

  async function setupTestObjects(currency: SupportedCurrency = 'USD') {
    const user = await models.User.createUserWithCollective(utils.data('user1'));
    const host = await models.User.createUserWithCollective(utils.data('host1'));
    const collective = await models.Collective.create(utils.data('collective1'));
    await collective.addHost(host.collective, host);
    const tier = await models.Tier.create({ ...utils.data('tier1'), CollectiveId: collective.id });
    const paymentMethod = await models.PaymentMethod.create(utils.data('paymentMethod2'));
    await models.ConnectedAccount.create({
      service: 'stripe',
      token: 'sk_test_XOFJ9lGbErcK5akcfdYM1D7j',
      username: 'acct_198T7jD8MNtzsDcg',
      CollectiveId: host.id,
    });
    const order = await models.Order.create({
      description: 'Donation',
      totalAmount: 500000,
      currency: currency,
      TierId: tier.id,
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      taxAmount: 7500,
      PaymentMethodId: paymentMethod.id,
    });
    /* eslint-disable camelcase */
    const charge = {
      id: 'ch_1Bs9ECBYycQg1OMfGIYoPFvk',
      object: 'charge',
      amount: 500000,
      amount_refunded: 0,
      application: 'ca_68FQ4jN0XMVhxpnk6gAptwvx90S9VYXF',
      application_fee: 'fee_1Bs9EEBYycQg1OMfdtHLPqEr',
      balance_transaction: 'txn_1Bs9EEBYycQg1OMfTR33Y5Xr',
      captured: true,
      created: 1517834264,
      currency: currency,
      customer: 'cus_9sKDFZkPwuFAF8',
    } as Stripe.Charge;
    const balanceTransaction = {
      id: 'txn_1Bs9EEBYycQg1OMfTR33Y5Xr',
      object: 'balance_transaction',
      amount: convertToStripeAmount(currency, 500000),
      currency: currency,
      fee: convertToStripeAmount(currency, 42500),
      fee_details: [
        { amount: convertToStripeAmount(currency, 17500), currency: currency, type: 'stripe_fee' },
        { amount: convertToStripeAmount(currency, 25000), currency: currency, type: 'application_fee' },
      ],
      net: convertToStripeAmount(currency, 457500),
      status: 'pending',
      type: 'charge',
    } as Stripe.BalanceTransaction;
    /* eslint-enable camelcase */
    const fees = extractFees(balanceTransaction, balanceTransaction.currency);
    const transactionPayload = {
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      PaymentMethodId: paymentMethod.id,
      type: TransactionTypes.CREDIT,
      OrderId: order.id,
      amount: order.totalAmount,
      taxAmount: order.taxAmount,
      currency: order.currency,
      hostCurrency: balanceTransaction.currency as SupportedCurrency,
      amountInHostCurrency: convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount),
      hostCurrencyFxRate:
        order.totalAmount / convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount),
      hostFeeInHostCurrency: calcFee(
        convertFromStripeAmount(balanceTransaction.currency, balanceTransaction.amount),
        collective.hostFeePercent,
      ),
      platformFeeInHostCurrency: fees.applicationFee,
      paymentProcessorFeeInHostCurrency: fees.stripeFee,
      description: order.description,
      data: { charge, balanceTransaction },
    };
    const transaction = await models.Transaction.createFromContributionPayload(transactionPayload);
    await fakeTransaction({
      ...pick(transaction, ['CollectiveId', 'HostCollectiveId']),
      amount: 100000,
      amountInHostCurrency: 100000,
      kind: TransactionKind.ADDED_FUNDS,
    });
    return { user, host, collective, tier, paymentMethod, order, transaction };
  }

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
      'taxAmount',
      'netAmountInCollectiveCurrency',
    ];

    await utils.preloadAssociationsForTransactions(transactions, columns);
    utils.snapshotTransactions(transactions, { columns });
  };

  beforeEach(async () => {
    await utils.resetTestDB();
  });

  afterEach(nock.cleanAll);

  /* Stripe will fully refund the processing fee for accounts created
   * prior to 09/17/17. The refunded fee can be seen in the balance
   * transaction call right after a refund.  The nock output isn't
   * complete but we really don't use the other fields retrieved from
   * Stripe. */
  describe('Stripe Transaction - for hosts created before September 17th 2017', () => {
    beforeEach(() =>
      initStripeNock({
        amount: -500000,
        fee: -17500,
        fee_details: [{ amount: -17500, type: 'stripe_fee' }], // eslint-disable-line camelcase
        net: -482500,
      }),
    );

    it('should create negative transactions with all the fees refunded', async () => {
      // Given that we create a user, host, collective, tier,
      // paymentMethod, an order and a transaction
      const { user, collective, host, transaction } = await setupTestObjects();

      // Balance pre-refund
      expect(await collective.getBalance()).to.eq(500000);

      // When the above transaction is refunded
      const result = await graphqlQueryV2(
        refundTransactionMutation,
        { transaction: { legacyId: transaction.id } },
        host,
      );

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
      expect(await collective.getBalance()).to.eq(100000);

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
      expect(tr1.amount).to.equal(-450000);
      expect(tr1.taxAmount).to.equal(-7500);
      expect(tr1.amountInHostCurrency).to.equal(-450000);
      expect(tr1.platformFeeInHostCurrency).to.equal(-25000);
      expect(tr1.hostFeeInHostCurrency).to.equal(0);
      expect(tr1.paymentProcessorFeeInHostCurrency).to.equal(-17500);
      expect(tr1.netAmountInCollectiveCurrency).to.equal(-500000);
      expect(tr1.RefundTransactionId).to.equal(tr4.id);

      // 2. Collective Ledger
      expect(tr2.type).to.equal('CREDIT');
      expect(tr2.FromCollectiveId).to.equal(user.CollectiveId);
      expect(tr2.CollectiveId).to.equal(collective.id);
      expect(tr2.amount).to.equal(500000);
      expect(tr2.taxAmount).to.equal(-7500);
      expect(tr2.amountInHostCurrency).to.equal(500000);
      expect(tr2.platformFeeInHostCurrency).to.equal(-25000);
      expect(tr2.hostFeeInHostCurrency).to.equal(0);
      expect(tr2.paymentProcessorFeeInHostCurrency).to.equal(-17500);
      expect(tr2.netAmountInCollectiveCurrency).to.equal(450000);
      expect(tr2.RefundTransactionId).to.equal(tr3.id);

      // 3. Refund Collective Ledger
      expect(tr3.type).to.equal('DEBIT');
      expect(tr3.FromCollectiveId).to.equal(user.CollectiveId);
      expect(tr3.CollectiveId).to.equal(collective.id);
      expect(tr3.platformFeeInHostCurrency).to.equal(25000);
      expect(tr3.hostFeeInHostCurrency).to.equal(0);
      expect(tr3.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(tr3.amount).to.equal(-500000);
      expect(tr3.taxAmount).to.equal(7500);
      expect(tr3.amountInHostCurrency).to.equal(-500000);
      expect(tr3.netAmountInCollectiveCurrency).to.equal(-467500);
      expect(tr3.RefundTransactionId).to.equal(tr2.id);
      expect(processorFeeRefund).to.exist;
      expect(processorFeeRefund.amount).to.eq(17500);
      expect(processorFeeRefund.FromCollectiveId).to.eq(host.id);
      expect(processorFeeRefund.CollectiveId).to.eq(collective.id);
      expect(hostFeeRefund).to.exist;

      // 4. Refund User Ledger
      expect(tr4.type).to.equal('CREDIT');
      expect(tr4.FromCollectiveId).to.equal(collective.id);
      expect(tr4.CollectiveId).to.equal(user.CollectiveId);
      expect(tr4.platformFeeInHostCurrency).to.equal(25000);
      expect(tr4.hostFeeInHostCurrency).to.equal(0);
      expect(tr4.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(tr4.netAmountInCollectiveCurrency).to.equal(500000);
      expect(tr4.amount).to.equal(467500);
      expect(tr4.taxAmount).to.equal(7500);
      expect(tr4.amountInHostCurrency).to.equal(467500);
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
    beforeEach(() => initStripeNock({ amount: -500000, fee: 0, fee_details: [], net: -500000 }));

    async function handleRefundTransaction(transaction, host, collective, user) {
      // When the above transaction is refunded
      const result = await graphqlQueryV2(
        refundTransactionMutation,
        { transaction: { legacyId: transaction.id } },
        host,
      );

      // Then there should be no errors
      if (result.errors) {
        throw result.errors;
      }

      // And then the returned value should match the transaction
      // passed to the mutation
      expect(result.data.refundTransaction.legacyId).to.equal(transaction.id);

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
      expect(tr1.amount).to.equal(-450000);
      expect(tr1.taxAmount).to.equal(-7500);
      expect(tr1.amountInHostCurrency).to.equal(-450000);
      expect(tr1.platformFeeInHostCurrency).to.equal(-25000);
      expect(tr1.hostFeeInHostCurrency).to.equal(0);
      expect(tr1.paymentProcessorFeeInHostCurrency).to.equal(-17500);
      expect(tr1.netAmountInCollectiveCurrency).to.equal(-500000);
      expect(tr1.RefundTransactionId).to.equal(tr4.id);

      // 2. Collective Ledger
      expect(tr2.type).to.equal('CREDIT');
      expect(tr2.FromCollectiveId).to.equal(user.CollectiveId);
      expect(tr2.CollectiveId).to.equal(collective.id);
      expect(tr2.amount).to.equal(500000);
      expect(tr2.taxAmount).to.equal(-7500);
      expect(tr2.amountInHostCurrency).to.equal(500000);
      expect(tr2.platformFeeInHostCurrency).to.equal(-25000);
      expect(tr2.hostFeeInHostCurrency).to.equal(0);
      expect(tr2.paymentProcessorFeeInHostCurrency).to.equal(-17500);
      expect(tr2.netAmountInCollectiveCurrency).to.equal(450000);
      expect(tr2.RefundTransactionId).to.equal(tr3.id);

      // 3. Refund Collective Ledger
      expect(tr3.type).to.equal('DEBIT');
      expect(tr3.FromCollectiveId).to.equal(user.CollectiveId);
      expect(tr3.CollectiveId).to.equal(collective.id);
      expect(tr3.platformFeeInHostCurrency).to.equal(25000);
      expect(tr3.hostFeeInHostCurrency).to.equal(0);
      expect(tr3.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(tr3.amount).to.equal(-500000);
      expect(tr3.taxAmount).to.equal(7500);
      expect(tr3.amountInHostCurrency).to.equal(-500000);
      expect(tr3.netAmountInCollectiveCurrency).to.equal(-467500);
      expect(tr3.RefundTransactionId).to.equal(tr2.id);

      // 4. Refund User Ledger
      expect(tr4.type).to.equal('CREDIT');
      expect(tr4.FromCollectiveId).to.equal(collective.id);
      expect(tr4.CollectiveId).to.equal(user.CollectiveId);
      expect(tr4.platformFeeInHostCurrency).to.equal(25000);
      expect(tr4.hostFeeInHostCurrency).to.equal(0);
      expect(tr4.paymentProcessorFeeInHostCurrency).to.equal(0);
      expect(tr4.amount).to.equal(467500);
      expect(tr4.taxAmount).to.equal(7500);
      expect(tr4.amountInHostCurrency).to.equal(467500);
      expect(tr4.netAmountInCollectiveCurrency).to.equal(500000);
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
});
