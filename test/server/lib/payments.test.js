import { expect } from 'chai';
import config from 'config';
import nock from 'nock';
import { createSandbox } from 'sinon';

import { activities } from '../../../server/constants';
import status from '../../../server/constants/order-status';
import { PLANS_COLLECTIVE_SLUG } from '../../../server/constants/plans';
import roles from '../../../server/constants/roles';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import emailLib from '../../../server/lib/email';
import { createRefundTransaction, executeOrder, sendOrderPendingEmail } from '../../../server/lib/payments';
import stripe from '../../../server/lib/stripe';
import models from '../../../server/models';
import { PayoutMethodTypes } from '../../../server/models/PayoutMethod';
import stripeMocks from '../../mocks/stripe';
import { fakeCollective, fakeHost, fakeOrder, fakePayoutMethod, fakeUser, randStr } from '../../test-helpers/fake-data';
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
      slug: PLANS_COLLECTIVE_SLUG,
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
              expect(emailSendSpy.lastCall.args[0]).to.equal(activities.ORDER_THANKYOU);
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
            expect(emailSendSpy.lastCall.args[0]).to.equal(activities.ORDER_THANKYOU);
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
      await fakeHost({ id: 8686, name: 'Open Collective' });
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
      await fakeHost({ id: 8686, name: 'Open Collective' });
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
      await fakeHost({ id: 8686, name: 'Open Collective' });
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
      await fakeHost({ id: 8686, name: 'Open Collective' });
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
});
