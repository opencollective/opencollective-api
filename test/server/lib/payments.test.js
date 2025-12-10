import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { createSandbox } from 'sinon';

import { activities } from '../../../server/constants';
import status from '../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods';
import PlatformConstants from '../../../server/constants/platform';
import roles from '../../../server/constants/roles';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import emailLib from '../../../server/lib/email';
import {
  createRefundTransaction,
  executeOrder,
  getHostFeePercent,
  pauseOrder,
  resumeOrder,
  sendOrderPendingEmail,
} from '../../../server/lib/payments';
import stripe from '../../../server/lib/stripe';
import models from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import * as paypalAPI from '../../../server/paymentProviders/paypal/api';
import stripeMocks from '../../mocks/stripe';
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakePayoutMethod,
  fakeUser,
  randStr,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const AMOUNT = 1099;
const AMOUNT2 = 199;
const CURRENCY = 'EUR';
const STRIPE_TOKEN = 'tok_123456781234567812345678';
const EMAIL = 'anotheruser@email.com';
const userData = utils.data('user3');
const PLAN_NAME = 'small';

const SNAPSHOT_COLUMNS = [
  'kind',
  'type',
  'isRefund',
  'isDebt',
  'FromCollectiveId',
  'CollectiveId',
  'HostCollectiveId',
  'amount',
  'currency',
  'platformFeeInHostCurrency',
  'paymentProcessorFeeInHostCurrency',
  'settlementStatus',
  'description',
];

describe('server/lib/payments', () => {
  let host, user, user2, collective, order, collective2, sandbox, emailSendSpy;

  before(() => {
    nock('https://data.fixer.io', { encodedQueryParams: true })
      .get('/latest')
      .times(19)
      .query({
        access_key: config.fixer.accessKey, // eslint-disable-line camelcase
        base: 'EUR',
        symbols: 'USD',
      })
      .reply(200, { base: 'EUR', date: '2017-10-05', rates: { USD: 1.1742 } });
  });

  after(() => {
    nock.cleanAll();
  });

  beforeEach(async () => {
    await utils.resetTestDB({ groupedTruncate: false });
    await utils.seedDefaultVendors();
  });

  beforeEach(() => {
    sandbox = createSandbox();
    sandbox.stub(stripe.customers, 'create').callsFake(() => Promise.resolve({ id: 'cus_BM7mGwp1Ea8RtL' }));
    sandbox.stub(stripe.customers, 'retrieve').callsFake(() => Promise.resolve({ id: 'cus_BM7mGwp1Ea8RtL' }));
    sandbox.stub(stripe.tokens, 'retrieve').callsFake(async id => ({ id }));
    sandbox.stub(stripe.tokens, 'create').callsFake(() => Promise.resolve({ id: 'tok_1AzPXGD8MNtzsDcgwaltZuvp' }));

    const paymentMethodId = randStr('pm_');
    sandbox
      .stub(stripe.paymentMethods, 'create')
      .resolves({ id: paymentMethodId, type: 'card', card: { fingerprint: 'fingerprint' } });
    sandbox
      .stub(stripe.paymentMethods, 'attach')
      .resolves({ id: paymentMethodId, type: 'card', card: { fingerprint: 'fingerprint' } });
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
    sandbox.stub(config, 'ledger').value({ ...config.ledger, separatePaymentProcessorFees: true, separateTaxes: true });
    emailSendSpy = sandbox.spy(emailLib, 'send');
  });

  afterEach(() => sandbox.restore());

  beforeEach('create a user', () => models.User.createUserWithCollective(userData).then(u => (user = u)));
  beforeEach('create a user', () =>
    models.User.createUserWithCollective({
      email: EMAIL,
      name: 'anotheruser',
    }).then(u => (user2 = u)),
  );
  beforeEach('create a host', () =>
    models.User.createUserWithCollective({
      ...utils.data('host1'),
      currency: CURRENCY,
    }).then(u => (host = u)),
  );
  beforeEach('create a collective', () =>
    models.Collective.create({
      ...utils.data('collective1'),
    }).then(g => (collective = g)),
  );
  beforeEach('create a collective', () =>
    models.Collective.create(utils.data('collective2')).then(g => (collective2 = g)),
  );
  beforeEach('create an order', async () => {
    const tier = await models.Tier.create({
      ...utils.data('tier1'),
      CollectiveId: collective.id,
      slug: PLAN_NAME,
    });
    const o = await models.Order.create({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      totalAmount: AMOUNT,
      currency: CURRENCY,
      TierId: tier.id,
    });

    order = await o.setPaymentMethod({ token: STRIPE_TOKEN });
  });
  beforeEach('add host to collective', () => collective.addHost(host, user, { shouldAutomaticallyApprove: true }));
  beforeEach('add host to collective2', () => collective2.addHost(host, user, { shouldAutomaticallyApprove: true }));

  beforeEach('create stripe account', async () => {
    await models.ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      CollectiveId: host.id,
      username: 'stripeAccount',
    });
  });

  /**
   * Post a payment.
   */
  describe('Checks payload', () => {
    describe('and fails to create a payment if', () => {
      it('interval is present and it is not month or year', () => {
        order.interval = 'something';
        return executeOrder(user, order).catch(err =>
          expect(err.message).to.equal('Interval should be null, month or year.'),
        );
      });

      it('payment amount is missing', () => {
        order.totalAmount = null;
        return executeOrder(user, order).catch(err => expect(err.message).to.equal('payment.amount missing'));
      });

      it('payment amount is less than 50', () => {
        order.totalAmount = 49;
        return executeOrder(user, order).catch(err =>
          expect(err.message).to.equal('payment.amount must be at least $0.50'),
        );
      });

      it('stripe token is missing', () => {
        order.PaymentMethodId = null;
        return executeOrder(user, order).catch(err =>
          expect(err.message).to.equal('PaymentMethodId missing in the order'),
        );
      });
    });

    describe('and when the order looks good', () => {
      describe('it fails', () => {
        it('if the host has no stripe account', () => {
          order.CollectiveId = user2.CollectiveId;
          return executeOrder(user, order).catch(err =>
            expect(err.message).to.equal(
              'The host for the anotheruser collective has no Stripe account set up (HostCollectiveId: null)',
            ),
          );
        });

        it('if stripe has live key and not in production', () =>
          models.ConnectedAccount.update(
            { service: 'stripe', token: 'sk_live_abc' },
            { where: { CollectiveId: host.CollectiveId } },
          )
            .then(() => executeOrder(user, order))
            .catch(err => expect(err.message).to.contain("You can't use a Stripe live key")));
      });

      describe('and payment succeeds', () => {
        describe('one-time', () => {
          describe('1st payment', () => {
            beforeEach('add transaction for collective 2', () =>
              models.Transaction.createDoubleEntry({
                CollectiveId: collective2.id,
                CreatedByUserId: user2.id,
                FromCollectiveId: user2.CollectiveId,
                netAmountInCollectiveCurrency: 10000,
                amount: 10000,
                type: 'CREDIT',
                PaymentMethodId: order.PaymentMethodId,
                HostCollectiveId: host.CollectiveId,
              }),
            );
            beforeEach('execute order', () => executeOrder(user, order));

            it('successfully creates a paymentMethod with the CreatedByUserId', () =>
              models.PaymentMethod.findAndCountAll({
                where: { CreatedByUserId: user.id },
              }).then(res => {
                expect(res.count).to.equal(1);
                expect(res.rows[0]).to.have.property('token', STRIPE_TOKEN);
                expect(res.rows[0]).to.have.property('service', 'stripe');
              }));

            it('successfully creates an order in the database', () =>
              models.Order.findAndCountAll().then(res => {
                expect(res.count).to.equal(1);
                const order = res.rows[0];
                expect(order).to.have.property('CreatedByUserId', user.id);
                expect(order).to.have.property('CollectiveId', collective.id);
                expect(order).to.have.property('currency', CURRENCY);
                expect(order).to.have.property('totalAmount', AMOUNT);
                expect(order).to.have.property('status', status.PAID);
              }));

            it('successfully adds the user as a backer', () =>
              models.Member.findOne({
                where: {
                  MemberCollectiveId: user.CollectiveId,
                  CollectiveId: collective.id,
                  role: roles.BACKER,
                },
              }).then(member => {
                expect(member).to.exist;
              }));

            it('successfully sends out an email to donor1', async () => {
              await utils.waitForCondition(() => emailSendSpy.callCount > 0);
              expect(emailSendSpy.lastCall.args[0]).to.equal(activities.ORDER_PROCESSED);
              expect(emailSendSpy.lastCall.args[1]).to.equal(user.email);
            });
          });

          describe('2nd payment with same stripeToken', () => {
            beforeEach('create first payment', () => executeOrder(user, order));

            beforeEach('create 2nd payment', () => {
              order.totalAmount = AMOUNT2;
              order.processedAt = null;
              return executeOrder(user, order);
            });

            it('does not re-create a paymentMethod', done => {
              models.PaymentMethod.findAndCountAll({
                where: { CreatedByUserId: user.id },
              })
                .then(res => {
                  expect(res.count).to.equal(1);
                  done();
                })
                .catch(done);
            });
          });
        });

        describe('recurringly', () => {
          let order2;

          beforeEach(() =>
            models.Order.create({
              CreatedByUserId: user2.id,
              FromCollectiveId: user2.CollectiveId,
              CollectiveId: collective2.id,
              totalAmount: AMOUNT2,
              currency: collective2.currency,
            })
              .then(o => o.setPaymentMethod({ token: STRIPE_TOKEN }))
              .then(o => (order2 = o)),
          );

          beforeEach('execute order', () => {
            order2.interval = 'month';
            return executeOrder(user, order2);
          });

          it('successfully creates a paymentMethod', () =>
            models.PaymentMethod.findAndCountAll({
              where: { CreatedByUserId: user2.id },
            }).then(res => {
              expect(res.count).to.equal(1);
            }));

          it('successfully creates an order in the database', () =>
            models.Order.findAndCountAll({ order: [['id', 'ASC']] }).then(res => {
              expect(res.count).to.equal(2);
              expect(res.rows[1]).to.have.property('CreatedByUserId', user2.id);
              expect(res.rows[1]).to.have.property('CollectiveId', collective2.id);
              expect(res.rows[1]).to.have.property('currency', CURRENCY);
              expect(res.rows[1]).to.have.property('totalAmount', AMOUNT2);
              expect(res.rows[1]).to.have.property('SubscriptionId');
              expect(res.rows[1]).to.have.property('status', status.ACTIVE);
            }));

          it('creates a Subscription model', () =>
            models.Subscription.findAndCountAll({}).then(res => {
              const subscription = res.rows[0];

              expect(res.count).to.equal(1);
              expect(subscription).to.have.property('amount', AMOUNT2);
              expect(subscription).to.have.property('interval', 'month');
              expect(subscription).to.have.property('data');
              expect(subscription).to.have.property('isActive', true);
              expect(subscription).to.have.property('currency', CURRENCY);
            }));

          it('successfully sends out an email to donor', async () => {
            await utils.waitForCondition(() => emailSendSpy.callCount > 0);
            expect(emailSendSpy.lastCall.args[0]).to.equal(activities.ORDER_PROCESSED);
            expect(emailSendSpy.lastCall.args[1]).to.equal(user2.email);
          });
        });
      });
    });
  });

  describe('createRefundTransaction', () => {
    it('should allow collective to start a refund', async () => {
      // Given the following pair of transactions created
      const transaction = await models.Transaction.createFromContributionPayload({
        CreatedByUserId: user.id,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: collective.id,
        PaymentMethodId: order.PaymentMethodId,
        type: 'CREDIT',
        OrderId: order.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        amountInHostCurrency: 5000,
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 250,
        platformFeeInHostCurrency: 250,
        taxAmount: 100,
        paymentProcessorFeeInHostCurrency: 175,
        description: 'Monthly subscription to Webpack',
        data: { charge: { id: 'ch_1AzPXHD8MNtzsDcgXpUhv4pm' } },
      });

      // When the refund transaction is created
      await createRefundTransaction(transaction, 0, { dataField: 'foo' }, user);

      // And when transactions for that order are retrieved
      const allTransactions = await models.Transaction.findAll({
        where: {
          OrderId: order.id,
        },
        order: [['id', 'ASC']],
      });

      // Snapshot ledger
      await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS);
      utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS });

      // Then there should be 12 transactions in total under that order id
      expect(allTransactions.length).to.equal(16);

      // TODO: check that HOST_FEES, PAYMENT_PROCESSOR_COVER are there
      const hostFeeTransactions = allTransactions.filter(t => t.kind === TransactionKind.HOST_FEE);
      expect(hostFeeTransactions).to.have.lengthOf(4);

      const taxTransactions = allTransactions.filter(t => t.kind === TransactionKind.TAX);
      expect(taxTransactions).to.have.lengthOf(4);

      // And Then two contribution transactions should be refund
      const refundTransactions = allTransactions.filter(
        t => t.kind === TransactionKind.CONTRIBUTION && t.isRefund === true,
      );
      expect(refundTransactions).to.have.lengthOf(2);

      // And then the values for the transaction from the collective
      // to the donor are correct
      const creditRefundTransaction = refundTransactions.find(t => t.type === 'CREDIT');
      expect(creditRefundTransaction.FromCollectiveId).to.equal(collective.id);
      expect(creditRefundTransaction.CollectiveId).to.equal(order.FromCollectiveId);
      expect(creditRefundTransaction.kind).to.equal(TransactionKind.CONTRIBUTION);
      expect(creditRefundTransaction.taxAmount).to.equal(0); // Taxes are moved to a separate transaction

      // And then the values for the transaction from the donor to the
      // collective also look correct
      const debitRefundTransaction = refundTransactions.find(t => t.type === 'DEBIT');
      expect(debitRefundTransaction.FromCollectiveId).to.equal(order.FromCollectiveId);
      expect(debitRefundTransaction.CollectiveId).to.equal(collective.id);
      expect(debitRefundTransaction.kind).to.equal(TransactionKind.CONTRIBUTION);
      expect(debitRefundTransaction.taxAmount).to.equal(0); // Taxes are moved to a separate transaction

      // Check taxes
      const refundTaxTransactions = allTransactions.filter(t => t.kind === TransactionKind.TAX && t.isRefund === true);
      expect(refundTaxTransactions).to.have.lengthOf(2);

      expect(refundTaxTransactions.find(t => t.type === 'DEBIT').amount).to.equal(-100);
      expect(refundTaxTransactions.find(t => t.type === 'CREDIT').amount).to.equal(100);
    });

    it('should refund platform fees on top when refunding original transaction', async () => {
      // Create Open Collective Inc
      await fakeHost({ id: PlatformConstants.PlatformCollectiveId, name: 'Open Collective' });
      const host = await fakeHost({ name: 'Host' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, name: 'Collective' });
      const contributorUser = await fakeUser(undefined, { name: 'User' });
      const order = await fakeOrder({
        status: 'ACTIVE',
        CollectiveId: collective.id,
        FromCollectiveId: contributorUser.CollectiveId,
      });
      const transaction = await models.Transaction.createFromContributionPayload({
        CreatedByUserId: contributorUser.id,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        PaymentMethodId: order.PaymentMethodId,
        type: 'CREDIT',
        OrderId: order.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        amountInHostCurrency: 5000,
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 250,
        paymentProcessorFeeInHostCurrency: 175,
        description: 'Monthly subscription to Webpack',
        data: { charge: { id: 'ch_refunded_charge' }, platformTip: 500 },
      });

      // Should have 8 transactions:
      // - 2 for contributions
      // - 2 for host fees
      // - 2 for payment processor fees
      // - 2 for platform tip (contributor -> Open Collective)
      // - 2 for platform tip debt (host -> Open Collective)
      const originalTransactions = await order.getTransactions();
      expect(originalTransactions).to.have.lengthOf(10);

      // Should have created a settlement entry for tip
      const tipTransaction = originalTransactions.find(t => t.kind === TransactionKind.PLATFORM_TIP_DEBT);
      const tipSettlement = await models.TransactionSettlement.getByTransaction(tipTransaction);
      expect(tipSettlement.status).to.eq('OWED');

      // Do refund
      await createRefundTransaction(transaction, 0, null, user);

      // Snapshot ledger
      const allTransactions = await order.getTransactions({ order: [['id', 'ASC']] });
      await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS);
      utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS });

      const refundedTransactions = await order.getTransactions({ where: { isRefund: true } });
      expect(refundedTransactions).to.have.lengthOf(10);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.CONTRIBUTION)).to.have.lengthOf(2);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.PLATFORM_TIP)).to.have.lengthOf(2);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.PLATFORM_TIP_DEBT)).to.have.lengthOf(2);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.HOST_FEE)).to.have.lengthOf(2);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.PAYMENT_PROCESSOR_COVER)).to.have.lengthOf(2);

      // TODO(LedgerRefactor): Check debt transactions and settlement status

      // Settlement should be marked as SETTLED since it's was not invoiced yet
      await tipSettlement.reload();
      expect(tipSettlement.status).to.eq('SETTLED');
    });

    it('should not create payment processor fee cover for contribution to the host itself', async () => {
      // Create Open Collective Inc
      await fakeHost({ id: PlatformConstants.PlatformCollectiveId, name: 'Open Collective' });
      const host = await fakeHost({ name: 'Host' });
      const contributorUser = await fakeUser(undefined, { name: 'User' });
      const order = await fakeOrder({
        status: 'ACTIVE',
        CollectiveId: host.id,
        FromCollectiveId: contributorUser.CollectiveId,
      });
      const transaction = await models.Transaction.createFromContributionPayload({
        CreatedByUserId: contributorUser.id,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        PaymentMethodId: order.PaymentMethodId,
        type: 'CREDIT',
        OrderId: order.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        amountInHostCurrency: 5000,
        hostCurrencyFxRate: 1,
        paymentProcessorFeeInHostCurrency: 175,
        description: 'Contribution to Open Collective',
        data: { charge: { id: 'ch_refunded_charge' } },
      });

      // Should have 4 transactions:
      // - 2 for contributions
      // - 2 for payment processor fees
      const originalTransactions = await order.getTransactions();
      expect(originalTransactions).to.have.lengthOf(4);
      expect(originalTransactions.filter(t => t.kind === TransactionKind.CONTRIBUTION)).to.have.lengthOf(2);
      expect(originalTransactions.filter(t => t.kind === TransactionKind.PAYMENT_PROCESSOR_FEE)).to.have.lengthOf(2);

      // Do refund
      await createRefundTransaction(transaction, 0, null, user);

      // Snapshot ledger
      const allTransactions = await order.getTransactions({ order: [['id', 'ASC']] });
      await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS);
      utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS });

      const refundedTransactions = await order.getTransactions({ where: { isRefund: true } });
      expect(refundedTransactions).to.have.lengthOf(2);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.CONTRIBUTION)).to.have.lengthOf(2);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.PAYMENT_PROCESSOR_COVER)).to.have.lengthOf(0);
    });

    it('should be able to refund only the host fee', async () => {
      // Create Open Collective Inc
      await fakeHost({ id: PlatformConstants.PlatformCollectiveId, name: 'Open Collective' });
      const host = await fakeHost({ name: 'Host' });
      const contributorUser = await fakeUser(undefined, { name: 'User' });
      const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });
      const order = await fakeOrder({
        status: 'PAID',
        CollectiveId: collective.id,
        FromCollectiveId: contributorUser.CollectiveId,
      });
      await models.Transaction.createFromContributionPayload({
        CreatedByUserId: contributorUser.id,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        PaymentMethodId: order.PaymentMethodId,
        type: 'CREDIT',
        OrderId: order.id,
        amount: 5000,
        currency: 'USD',
        hostCurrency: 'USD',
        amountInHostCurrency: 5000,
        hostFeeInHostCurrency: 500,
        description: 'Contribution to Collective',
      });

      // Should have 4 transactions:
      // - 2 for contributions
      // - 2 for payment processor fees
      const originalTransactions = await order.getTransactions();
      expect(originalTransactions).to.have.lengthOf(4);
      expect(originalTransactions.filter(t => t.kind === TransactionKind.CONTRIBUTION)).to.have.lengthOf(2);
      expect(originalTransactions.filter(t => t.kind === TransactionKind.HOST_FEE)).to.have.lengthOf(2);

      // Do refund
      const hostFeeTransaction = originalTransactions.find(
        t => t.kind === TransactionKind.HOST_FEE && t.type === 'CREDIT',
      );
      await createRefundTransaction(hostFeeTransaction, 0, null, user);

      const refundedTransactions = await order.getTransactions({ where: { isRefund: true } });
      expect(refundedTransactions).to.have.lengthOf(2);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.CONTRIBUTION)).to.have.lengthOf(0);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.HOST_FEE)).to.have.lengthOf(2);

      // Snapshot ledger
      const allTransactions = await order.getTransactions({ order: [['id', 'ASC']] });
      await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS);
      utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS });
    });

    it('should be able to refund only the platform tip', async () => {
      // Create Open Collective Inc
      await fakeHost({ id: PlatformConstants.PlatformCollectiveId, name: 'Open Collective' });
      const host = await fakeHost({ name: 'Host' });
      const contributorUser = await fakeUser(undefined, { name: 'User' });
      const collective = await fakeCollective({ name: 'Collective', HostCollectiveId: host.id });
      const order = await fakeOrder({
        status: 'PAID',
        CollectiveId: collective.id,
        FromCollectiveId: contributorUser.CollectiveId,
      });
      await models.Transaction.createFromContributionPayload({
        CreatedByUserId: contributorUser.id,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        PaymentMethodId: order.PaymentMethodId,
        type: 'CREDIT',
        OrderId: order.id,
        amount: 5500,
        currency: 'USD',
        hostCurrency: 'USD',
        amountInHostCurrency: 5500,
        description: 'Contribution to Collective',
        data: { platformTip: 500, isPlatformRevenueDirectlyCollected: true },
      });

      // Should have 4 transactions:
      // - 2 for contributions
      // - 2 for payment processor fees
      const originalTransactions = await order.getTransactions();
      expect(originalTransactions).to.have.lengthOf(4);
      expect(originalTransactions.filter(t => t.kind === TransactionKind.CONTRIBUTION)).to.have.lengthOf(2);
      expect(originalTransactions.filter(t => t.kind === TransactionKind.PLATFORM_TIP)).to.have.lengthOf(2);

      // Do refund
      const platformTipTransaction = originalTransactions.find(
        t => t.kind === TransactionKind.PLATFORM_TIP && t.type === 'CREDIT',
      );
      await createRefundTransaction(platformTipTransaction, 0, null, user);

      const refundedTransactions = await order.getTransactions({ where: { isRefund: true } });
      expect(refundedTransactions).to.have.lengthOf(2);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.CONTRIBUTION)).to.have.lengthOf(0);
      expect(refundedTransactions.filter(t => t.kind === TransactionKind.PLATFORM_TIP)).to.have.lengthOf(2);

      // Snapshot ledger
      const allTransactions = await order.getTransactions({ order: [['id', 'ASC']] });
      await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS);
      utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS });
    });

    it('should remove the settlement if the tip was already invoiced', async () => {
      // TODO(LedgerRefactor)
    });

    it('should revert the settlement if the tip was already paid', async () => {
      // TODO(LedgerRefactor)
    });

    describe('partial refunds', () => {
      it('can be done with a valid amount', async () => {
        // Given the following pair of transactions created
        const transaction = await models.Transaction.createFromContributionPayload({
          CreatedByUserId: user.id,
          FromCollectiveId: order.FromCollectiveId,
          CollectiveId: collective.id,
          PaymentMethodId: order.PaymentMethodId,
          type: 'CREDIT',
          OrderId: order.id,
          amount: 5000,
          currency: 'USD',
          hostCurrency: 'USD',
          amountInHostCurrency: 5000,
          hostCurrencyFxRate: 1,
          hostFeeInHostCurrency: 250,
          platformFeeInHostCurrency: 250,
          taxAmount: 100,
          paymentProcessorFeeInHostCurrency: 175,
          description: 'Monthly subscription to Webpack',
          data: { charge: { id: 'ch_1AzPXHD8MNtzsDcgXpUhv4pm' } },
        });

        // When the refund transaction is created
        await createRefundTransaction(transaction, 100, { dataField: 'foo' }, user);

        // And when transactions for that order are retrieved
        const allTransactions = await models.Transaction.findAll({
          where: { OrderId: order.id },
          order: [['id', 'ASC']],
        });

        // Snapshot ledger
        await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS);
        utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS });

        // Then there should be 12 transactions in total under that order id
        expect(allTransactions.length).to.equal(18);

        // And Then two contribution transactions should be refund
        const paymentProcessorFeeRefundTransactions = allTransactions.filter(
          t => t.kind === TransactionKind.PAYMENT_PROCESSOR_FEE && t.isRefund === true,
        );
        expect(paymentProcessorFeeRefundTransactions).to.have.lengthOf(2);
        expect(paymentProcessorFeeRefundTransactions[0].amount).to.equal(-100);
        expect(paymentProcessorFeeRefundTransactions[1].amount).to.equal(100);

        // And the host should cover for the difference
        const paymentProcessorCoverTransactions = allTransactions.filter(
          t => t.kind === TransactionKind.PAYMENT_PROCESSOR_COVER && t.isRefund === true,
        );
        expect(paymentProcessorCoverTransactions).to.have.lengthOf(2);
        expect(paymentProcessorCoverTransactions[0].type).to.equal('DEBIT');
        expect(paymentProcessorCoverTransactions[0].amount).to.equal(-75);
        expect(paymentProcessorCoverTransactions[0].CollectiveId).to.equal(host.id);
        expect(paymentProcessorCoverTransactions[1].type).to.equal('CREDIT');
        expect(paymentProcessorCoverTransactions[1].amount).to.equal(75);
        expect(paymentProcessorCoverTransactions[1].CollectiveId).to.equal(collective.id);
      });

      it('works with multi-currency', async () => {
        // Given the following pair of transactions created
        const transaction = await models.Transaction.createFromContributionPayload({
          CreatedByUserId: user.id,
          FromCollectiveId: order.FromCollectiveId,
          CollectiveId: collective.id,
          PaymentMethodId: order.PaymentMethodId,
          type: 'CREDIT',
          OrderId: order.id,
          amount: 5000,
          currency: 'EUR',
          hostCurrency: 'USD',
          hostCurrencyFxRate: 1.1,
          amountInHostCurrency: 5500,
          hostFeeInHostCurrency: 250,
          platformFeeInHostCurrency: 250,
          taxAmount: 100,
          paymentProcessorFeeInHostCurrency: 175,
          description: 'Monthly subscription to Webpack',
          data: { charge: { id: 'ch_1AzPXHD8MNtzsDcgXpUhv4pm' } },
        });

        // When the refund transaction is created
        await createRefundTransaction(transaction, 100, { dataField: 'foo' }, user);

        // And when transactions for that order are retrieved
        const allTransactions = await models.Transaction.findAll({
          where: { OrderId: order.id },
          order: [['id', 'ASC']],
        });

        // Snapshot ledger
        await utils.preloadAssociationsForTransactions(allTransactions, SNAPSHOT_COLUMNS);
        utils.snapshotTransactions(allTransactions, { columns: SNAPSHOT_COLUMNS });

        // Then there should be 12 transactions in total under that order id
        expect(allTransactions.length).to.equal(18);

        // And Then two contribution transactions should be refund
        const paymentProcessorFeeRefundTransactions = allTransactions.filter(
          t => t.kind === TransactionKind.PAYMENT_PROCESSOR_FEE && t.isRefund === true,
        );
        expect(paymentProcessorFeeRefundTransactions).to.have.lengthOf(2);
        expect(paymentProcessorFeeRefundTransactions[0].amount).to.equal(-91); // 100 / 1.1
        expect(paymentProcessorFeeRefundTransactions[0].currency).to.equal('EUR');
        expect(paymentProcessorFeeRefundTransactions[0].amountInHostCurrency).to.equal(-100);
        expect(paymentProcessorFeeRefundTransactions[0].hostCurrency).to.equal('USD');
        expect(paymentProcessorFeeRefundTransactions[0].hostCurrencyFxRate).to.equal(1.1);

        expect(paymentProcessorFeeRefundTransactions[1].amount).to.equal(91); // 100 / 1.1
        expect(paymentProcessorFeeRefundTransactions[1].currency).to.equal('EUR');
        expect(paymentProcessorFeeRefundTransactions[1].amountInHostCurrency).to.equal(100);
        expect(paymentProcessorFeeRefundTransactions[1].hostCurrency).to.equal('USD');
        expect(paymentProcessorFeeRefundTransactions[1].hostCurrencyFxRate).to.equal(1.1);

        // And the host should cover for the difference
        const paymentProcessorCoverTransactions = allTransactions.filter(
          t => t.kind === TransactionKind.PAYMENT_PROCESSOR_COVER && t.isRefund === true,
        );
        expect(paymentProcessorCoverTransactions).to.have.lengthOf(2);
        expect(paymentProcessorCoverTransactions[0].type).to.equal('DEBIT');
        expect(paymentProcessorCoverTransactions[0].amount).to.equal(-64); // (175 - 100) / 1.1
        expect(paymentProcessorCoverTransactions[0].CollectiveId).to.equal(host.id);
        expect(paymentProcessorCoverTransactions[1].type).to.equal('CREDIT');
        expect(paymentProcessorCoverTransactions[1].amount).to.equal(64); // (175 - 100) / 1.1
        expect(paymentProcessorCoverTransactions[1].CollectiveId).to.equal(collective.id);
      });
    });
  }); /* createRefundTransaction */

  describe('sendOrderPendingEmail', () => {
    let order;

    beforeEach(async () => {
      const host = await fakeHost({
        settings: {
          paymentMethods: {
            manual: {
              instructions:
                'Please make a bank transfer as follows:\n\n<code>\n    Amount: {amount}\n    Reference/Communication: {OrderId}\n    {account}\n</code>\n\nPlease note that it will take a few days to process your payment.',
            },
          },
        },
      });
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      await fakePayoutMethod({
        CollectiveId: host.id,
        type: PayoutMethodTypes.BANK_ACCOUNT,
        data: {
          type: 'sort_code',
          accountHolderName: 'John Malkovich',
          currency: 'GBP',
          details: {
            IBAN: 'DE893219828398123',
            sortCode: '40-30-20',
            legalType: 'PRIVATE',
            accountNumber: '12345678',
            address: {
              country: 'US',
              state: 'NY',
              city: 'New York',
              zip: '10001',
            },
          },
          isManualBankTransfer: true,
        },
      });
      order = await fakeOrder({ CollectiveId: collective.id });
    });

    it('should include account information', async () => {
      await sendOrderPendingEmail(order);
      await utils.waitForCondition(() => emailSendSpy.callCount > 0);

      expect(emailSendSpy.lastCall.args[2]).to.have.property('account');
      expect(emailSendSpy.lastCall.args[2].instructions).to.include('IBAN: DE893219828398123');
    });
  });

  describe('pause and resume orders', () => {
    describe('stripe', () => {
      let orderToPause;

      it('pauses order', async () => {
        const paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
        const orderValues = { status: 'ACTIVE', interval: 'month', PaymentMethodId: paymentMethod.id };
        orderToPause = await fakeOrder(orderValues, { withSubscription: true });
        await pauseOrder(orderToPause, 'Paused for no reason', 'HOST');
        const updatedOrder = await models.Order.findByPk(orderToPause.id, { include: { association: 'Subscription' } });
        expect(updatedOrder.status).to.equal('PAUSED');
        expect(updatedOrder.data.messageForContributors).to.equal('Paused for no reason');
        expect(updatedOrder.data.pausedBy).to.equal('HOST');
        expect(updatedOrder.Subscription.isActive).to.be.false;
        expect(updatedOrder.Subscription.deactivatedAt).to.be.a('Date');
      });

      it('resumes order', async () => {
        const paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
        const orderValues = { status: 'PAUSED', interval: 'month', PaymentMethodId: paymentMethod.id };
        orderToPause = await fakeOrder(orderValues, { withSubscription: true });
        await resumeOrder(orderToPause, "Let's continue");
        const updatedOrder = await models.Order.findByPk(orderToPause.id, { include: { association: 'Subscription' } });
        expect(updatedOrder.status).to.equal('ACTIVE');
        expect(updatedOrder.Subscription.isActive).to.be.true;
        expect(updatedOrder.Subscription.deactivatedAt).to.be.null;
      });
    });

    describe('paypal', () => {
      let orderToPause, paypalRequestStub;

      beforeEach(() => {
        paypalRequestStub = sandbox.stub(paypalAPI, 'paypalRequest');
      });

      afterEach(() => {
        paypalRequestStub.restore();
      });

      it('pauses order', async () => {
        const paymentMethod = await fakePaymentMethod({ service: 'paypal', type: 'subscription' });
        const orderValues = { status: 'ACTIVE', interval: 'month', PaymentMethodId: paymentMethod.id };
        orderToPause = await fakeOrder(orderValues, { withSubscription: true });
        await pauseOrder(orderToPause, 'Paused for no reason', 'HOST');
        const updatedOrder = await models.Order.findByPk(orderToPause.id, { include: { association: 'Subscription' } });
        expect(updatedOrder.status).to.equal('PAUSED');
        expect(updatedOrder.data.messageForContributors).to.equal('Paused for no reason');
        expect(updatedOrder.data.pausedBy).to.equal('HOST');
        expect(updatedOrder.Subscription.isActive).to.be.false;
        expect(updatedOrder.Subscription.deactivatedAt).to.be.a('Date');
        expect(paypalRequestStub.calledOnce).to.be.true;
      });

      it('resumes order', async () => {
        const paymentMethod = await fakePaymentMethod({ service: 'paypal', type: 'subscription' });
        const orderValues = { status: 'PAUSED', interval: 'month', PaymentMethodId: paymentMethod.id };
        orderToPause = await fakeOrder(orderValues, { withSubscription: true });
        await resumeOrder(orderToPause, "Let's continue");
        const updatedOrder = await models.Order.findByPk(orderToPause.id, { include: { association: 'Subscription' } });
        expect(updatedOrder.status).to.equal('ACTIVE');
        expect(updatedOrder.Subscription.isActive).to.be.true;
        expect(updatedOrder.Subscription.deactivatedAt).to.be.null;
        expect(paypalRequestStub.calledOnce).to.be.true;
      });

      it('throws if cancellation fails on PayPal', async () => {
        const paymentMethod = await fakePaymentMethod({ service: 'paypal', type: 'subscription' });
        const orderValues = { status: 'ACTIVE', interval: 'month', PaymentMethodId: paymentMethod.id };
        orderToPause = await fakeOrder(orderValues, { withSubscription: true });
        paypalRequestStub.rejects(new Error('PayPal error'));
        await expect(pauseOrder(orderToPause, 'Paused for no reason', 'HOST')).to.be.rejectedWith(
          'Failed to pause PayPal subscription',
        );

        const updatedOrder = await models.Order.findByPk(orderToPause.id, { include: { association: 'Subscription' } });
        expect(updatedOrder.status).to.equal('ACTIVE');
        expect(updatedOrder.Subscription.isActive).to.be.true;
      });
    });
  });

  describe('getHostFeePercent', () => {
    let testHost, testCollective, testParent, testOrder, testPaymentMethod;

    beforeEach(async () => {
      // Create a host with default settings
      testHost = await fakeHost({
        name: 'Test Host',
      });

      // Create a parent collective
      testParent = await fakeCollective({
        name: 'Parent Collective',
        HostCollectiveId: testHost.id,
      });

      // Create a collective with a host
      testCollective = await fakeCollective({
        name: 'Test Collective',
        HostCollectiveId: testHost.id,
        ParentCollectiveId: testParent.id,
        hostFeePercent: 10,
      });

      // Create a default payment method
      testPaymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });

      // Create a test order
      testOrder = await fakeOrder({
        CollectiveId: testCollective.id,
        PaymentMethodId: testPaymentMethod.id,
        totalAmount: 10000,
      });

      await testOrder.populate();
    });

    describe('basic cases', () => {
      it('returns 0 when collective is a host itself', async () => {
        const hostOrder = await fakeOrder({
          CollectiveId: testHost.id,
          PaymentMethodId: testPaymentMethod.id,
        });
        await hostOrder.populate();

        const feePercent = await getHostFeePercent(hostOrder);
        expect(feePercent).to.equal(0);
      });

      it('returns collective hostFeePercent as default', async () => {
        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(10);
      });

      it('returns order.data.hostFeePercent if set', async () => {
        testOrder.data = { hostFeePercent: 15 };
        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(15);
      });

      it('returns platform default if no other value is set', async () => {
        testCollective.hostFeePercent = null;
        await testCollective.save();
        testOrder.collective = testCollective;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(config.fees.default.hostPercent);
      });
    });

    describe('pending and manual contributions', () => {
      it('uses bankTransfersHostFeePercent from collective for pending contributions', async () => {
        testCollective.data = { bankTransfersHostFeePercent: 6 };
        await testCollective.save();
        testOrder.data = { isPendingContribution: true };
        testOrder.collective = testCollective;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(6);
      });

      it('uses bankTransfersHostFeePercent from parent for pending contributions', async () => {
        testParent.data = { bankTransfersHostFeePercent: 5 };
        await testParent.save();
        testOrder.data = { isPendingContribution: true };
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(5);
      });

      it('uses bankTransfersHostFeePercent from host for pending contributions', async () => {
        testHost.data = { bankTransfersHostFeePercent: 8 };
        await testHost.save();
        testOrder.data = { isPendingContribution: true };
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(8);
      });

      it('uses custom host fee from collective when useCustomHostFee is set', async () => {
        testCollective.data = { useCustomHostFee: true };
        testCollective.hostFeePercent = 12;
        await testCollective.save();
        testOrder.data = { isPendingContribution: true };
        testOrder.collective = testCollective;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(12);
      });

      it('uses custom host fee from parent when useCustomHostFee is set', async () => {
        testParent.data = { useCustomHostFee: true };
        testParent.hostFeePercent = 7;
        await testParent.save();
        testOrder.PaymentMethodId = null;
        testOrder.data = { isPendingContribution: true };
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(7);
      });

      it('handles manual contributions with opencollective.manual payment method', async () => {
        const manualPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.MANUAL,
        });
        testOrder.PaymentMethodId = manualPM.id;
        testOrder.paymentMethod = manualPM;
        testHost.data = { bankTransfersHostFeePercent: 9 };
        await testHost.save();
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(9);
      });

      it('handles isManualContribution flag', async () => {
        testCollective.data = { bankTransfersHostFeePercent: 6 };
        await testCollective.save();
        testOrder.data = { isManualContribution: true };
        testOrder.collective = testCollective;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(6);
      });
    });

    describe('prepaid payment methods', () => {
      it('uses hostFeePercent from prepaid payment method data', async () => {
        const prepaidPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.PREPAID,
          data: { hostFeePercent: 3 },
        });
        testOrder.PaymentMethodId = prepaidPM.id;
        testOrder.paymentMethod = prepaidPM;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(3);
      });

      it('falls back to collective fee if prepaid has no hostFeePercent', async () => {
        const prepaidPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.PREPAID,
          data: {},
        });
        testOrder.PaymentMethodId = prepaidPM.id;
        testOrder.paymentMethod = prepaidPM;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(10);
      });
    });

    describe('added funds (host payment method)', () => {
      it('uses addedFundsHostFeePercent from collective', async () => {
        const hostPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.HOST,
        });
        testCollective.data = { addedFundsHostFeePercent: 4 };
        await testCollective.save();
        testOrder.PaymentMethodId = hostPM.id;
        testOrder.paymentMethod = hostPM;
        testOrder.collective = testCollective;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(4);
      });

      it('uses addedFundsHostFeePercent from parent', async () => {
        const hostPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.HOST,
        });
        testParent.data = { addedFundsHostFeePercent: 2 };
        await testParent.save();
        testOrder.PaymentMethodId = hostPM.id;
        testOrder.paymentMethod = hostPM;
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(2);
      });

      it('uses addedFundsHostFeePercent from host', async () => {
        const hostPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.HOST,
        });
        testHost.data = { addedFundsHostFeePercent: 1 };
        await testHost.save();
        testOrder.PaymentMethodId = hostPM.id;
        testOrder.paymentMethod = hostPM;
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(1);
      });

      it('uses custom host fee from collective when useCustomHostFee is set', async () => {
        const hostPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.HOST,
        });
        testCollective.data = { useCustomHostFee: true };
        testCollective.hostFeePercent = 11;
        await testCollective.save();
        testOrder.PaymentMethodId = hostPM.id;
        testOrder.paymentMethod = hostPM;
        testOrder.collective = testCollective;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(11);
      });

      it('uses custom host fee from parent when useCustomHostFee is set', async () => {
        const hostPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.HOST,
        });
        testParent.data = { useCustomHostFee: true };
        testParent.hostFeePercent = 9;
        await testParent.save();
        testOrder.PaymentMethodId = hostPM.id;
        testOrder.paymentMethod = hostPM;
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(9);
      });
    });

    describe('collective to collective (same host)', () => {
      it('returns 0 for collective payment method', async () => {
        const collectivePM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.COLLECTIVE,
        });
        testOrder.PaymentMethodId = collectivePM.id;
        testOrder.paymentMethod = collectivePM;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(0);
      });
    });

    describe('stripe payments', () => {
      it('uses custom host fee from collective when useCustomHostFee is set', async () => {
        testCollective.data = { useCustomHostFee: true };
        testCollective.hostFeePercent = 13;
        await testCollective.save();
        testOrder.collective = testCollective;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(13);
      });

      it('uses custom host fee from parent when useCustomHostFee is set', async () => {
        testParent.data = { useCustomHostFee: true };
        testParent.hostFeePercent = 8;
        await testParent.save();
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(8);
      });

      it('uses stripeNotPlatformTipEligibleHostFeePercent when not platform tip eligible', async () => {
        testHost.data = { stripeNotPlatformTipEligibleHostFeePercent: 15 };
        await testHost.save();
        testOrder.platformTipEligible = false;
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(15);
      });

      it('does not use stripeNotPlatformTipEligibleHostFeePercent when platform tip eligible', async () => {
        testHost.data = { stripeNotPlatformTipEligibleHostFeePercent: 15 };
        await testHost.save();
        testOrder.platformTipEligible = true;
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(10); // Falls back to collective fee
      });
    });

    describe('paypal payments', () => {
      beforeEach(async () => {
        const paypalPM = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.PAYPAL,
          type: PAYMENT_METHOD_TYPE.PAYMENT,
        });
        testOrder.PaymentMethodId = paypalPM.id;
        testOrder.paymentMethod = paypalPM;
      });

      it('uses custom host fee from collective when useCustomHostFee is set', async () => {
        testCollective.data = { useCustomHostFee: true };
        testCollective.hostFeePercent = 14;
        await testCollective.save();
        testOrder.collective = testCollective;

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(14);
      });

      it('uses custom host fee from parent when useCustomHostFee is set', async () => {
        testParent.data = { useCustomHostFee: true };
        testParent.hostFeePercent = 6;
        await testParent.save();
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(6);
      });

      it('uses paypalNotPlatformTipEligibleHostFeePercent when not platform tip eligible', async () => {
        testHost.data = { paypalNotPlatformTipEligibleHostFeePercent: 16 };
        await testHost.save();
        testOrder.platformTipEligible = false;
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(16);
      });

      it('does not use paypalNotPlatformTipEligibleHostFeePercent when platform tip eligible', async () => {
        testHost.data = { paypalNotPlatformTipEligibleHostFeePercent: 16 };
        await testHost.save();
        testOrder.platformTipEligible = true;
        await testOrder.populate();

        const feePercent = await getHostFeePercent(testOrder);
        expect(feePercent).to.equal(10); // Falls back to collective fee
      });
    });

    describe('edge cases', () => {
      it('handles null parent collective', async () => {
        const noParentCollective = await fakeCollective({
          name: 'No Parent Collective',
          HostCollectiveId: testHost.id,
          ParentCollectiveId: null,
          hostFeePercent: 7,
        });
        const noParentOrder = await fakeOrder({
          CollectiveId: noParentCollective.id,
          PaymentMethodId: testPaymentMethod.id,
        });
        await noParentOrder.populate();

        const feePercent = await getHostFeePercent(noParentOrder);
        expect(feePercent).to.equal(7);
      });

      it('handles null host', async () => {
        const noHostCollective = await fakeCollective({
          name: 'No Host Collective',
          HostCollectiveId: null,
          hostFeePercent: 5,
        });
        const noHostOrder = await fakeOrder({
          CollectiveId: noHostCollective.id,
          PaymentMethodId: testPaymentMethod.id,
        });
        await noHostOrder.populate();

        const feePercent = await getHostFeePercent(noHostOrder);
        expect(feePercent).to.equal(5);
      });
    });
  });
});
