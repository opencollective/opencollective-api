import { expect } from 'chai';
import gql from 'fake-tag';
import moment from 'moment';
import nock from 'nock';
import { createSandbox, stub } from 'sinon';

import { maxInteger } from '../../../../server/constants/math';
import { idEncode, IDENTIFIER_TYPES } from '../../../../server/graphql/v2/identifiers';
import models from '../../../../server/models';
import giftcard from '../../../../server/paymentProviders/opencollective/giftcard';
import creditCardLib from '../../../../server/paymentProviders/stripe/creditcard';
import * as store from '../../../stores';
import { fakeOrder } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const gqlV1 = gql;

const ORDER_TOTAL_AMOUNT = 5000;
const STRIPE_FEE_STUBBED_VALUE = 300;

/* eslint-disable camelcase */
const fixerNock = function () {
  nock('https://data.fixer.io', { encodedQueryParams: true })
    .get('/latest')
    .times(2)
    .query({ access_key: /.*/i, base: 'EUR', symbols: 'USD' })
    .reply(200, {
      success: true,
      timestamp: 1532557927,
      historical: true,
      base: 'EUR',
      date: '2018-07-25',
      rates: { USD: 1.173428 },
    });
  nock('https://data.fixer.io', { encodedQueryParams: true })
    .get('/latest')
    .times(2)
    .query({ access_key: /.*/i, base: 'EUR', symbols: 'USD' })
    .reply(200, {
      success: true,
      timestamp: 1532557927,
      historical: true,
      base: 'EUR',
      date: '2018-07-25',
      rates: { USD: 1.173428 },
    });
  nock('https://data.fixer.io', { encodedQueryParams: true })
    .get('/latest')
    .times(2)
    .query({ access_key: /.*/i, base: 'EUR', symbols: 'USD' })
    .reply(200, {
      success: true,
      timestamp: 1532557927,
      historical: true,
      base: 'EUR',
      date: '2018-07-25',
      rates: { USD: 1.173428 },
    });
  nock('https://data.fixer.io', { encodedQueryParams: true })
    .get('/latest')
    .times(2)
    .query({ access_key: /.*/i, base: 'EUR', symbols: 'USD' })
    .reply(200, {
      success: true,
      timestamp: 1532557927,
      historical: true,
      base: 'EUR',
      date: '2018-07-25',
      rates: { USD: 1.173428 },
    });
};
/* eslint-enable camelcase */

const createOrderMutation = gql`
  mutation CreateOrder($order: OrderCreateInput!) {
    createOrder(order: $order) {
      order {
        id
        legacyId
        fromAccount {
          id
          slug
        }
        toAccount {
          id
          slug
        }
        frequency
        totalAmount {
          valueInCents
          currency
        }
        description
      }
    }
  }
`;

const updateOrderMutation = gql`
  mutation UpdateOrder($order: OrderReferenceInput!, $paymentMethod: PaymentMethodReferenceInput) {
    updateOrder(order: $order, paymentMethod: $paymentMethod) {
      id
      paymentMethod {
        id
      }
    }
  }
`;

describe('server/paymentProviders/opencollective/giftcard', () => {
  let sandbox;

  before(fixerNock);
  after(() => {
    nock.cleanAll();
  });

  beforeEach(() => {
    sandbox = createSandbox();
    // And given that the endpoint for creating customers on Stripe
    // is patched
    utils.stubStripeCreate(
      sandbox,
      {
        charge: { currency: 'usd', status: 'succeeded' },
      },
      { skipPaymentIntents: true },
    );
    // And given the stripe stuff that depends on values in the
    // order struct is patch. It's here and not on each test because
    // the `totalAmount' field doesn't change throught the tests.
    // Balance tx amount must match PaymentIntent (see createChargeTransactions + stubStripeBalanceSyncWithPaymentIntent).
    utils.stubStripeBalanceSyncWithPaymentIntent(sandbox, { stripeFee: STRIPE_FEE_STUBBED_VALUE });
  });

  afterEach(() => sandbox.restore());

  describe('paymentProviders.opencollective.giftcard', () => {
    describe('#processOrder', async () => {
      let host1, collective1, collective2, paymentMethod1, giftCardPaymentMethod, user, user1, userCollective;

      before(() => utils.resetTestDB());

      before('create Host 1(USD)', () =>
        models.Collective.create({
          name: 'Host 1',
          currency: 'USD',
          isActive: true,
          approvedAt: new Date(),
        }).then(c => {
          host1 = c;
          // Create stripe connected account to host
          return store.stripeConnectedAccount(host1.id);
        }),
      );

      before('create collective1', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          HostCollectiveId: host1.id,
          isActive: true,
          approvedAt: new Date(),
        }).then(c => (collective1 = c)),
      );
      before('create collective2', () =>
        models.Collective.create({
          name: 'collective2',
          currency: 'USD',
          HostCollectiveId: host1.id,
          isActive: true,
          approvedAt: new Date(),
        }).then(c => (collective2 = c)),
      );

      before('creates User 1', () =>
        models.User.createUserWithCollective({
          email: store.randEmail(),
          name: 'User 1',
        }).then(u => (user1 = u)),
      );
      before('user1 to become Admin of collective1', () => {
        return models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: 'ADMIN',
        }).then(() => {
          return user1.populateRoles();
        });
      });

      before('create a credit card payment method', () =>
        models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: null,
        }).then(pm => (paymentMethod1 = pm)),
      );

      beforeEach('create a claimed gift card payment method', async () => {
        user = await models.User.createUserWithCollective({
          email: store.randEmail('giftcard-claimer@opencollective.com'),
          name: 'Gift Card Claimer',
        });
        userCollective = user.collective;
        giftCardPaymentMethod = await models.PaymentMethod.create({
          name: 'gift card test',
          description: 'gift card test',
          SourcePaymentMethodId: paymentMethod1.id,
          initialBalance: 10000,
          monthlyLimitPerMember: null,
          currency: 'USD',
          CollectiveId: userCollective.id,
          CreatedByUserId: user1.id,
          service: 'opencollective',
          type: 'giftcard',
          confirmedAt: new Date(),
          expiryDate: moment().add(24, 'months').toDate(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      });

      it('Order should NOT be executed because its amount exceeds the balance of the gift card', async () => {
        expect(giftCardPaymentMethod.SourcePaymentMethodId).to.be.equal(paymentMethod1.id);
        const order = await models.Order.create({
          CreatedByUserId: user.id,
          FromCollectiveId: userCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: giftCardPaymentMethod.id,
          totalAmount: maxInteger,
          currency: 'USD',
        });
        order.fromCollective = userCollective;
        order.collective = collective2;
        order.createdByUser = user;
        order.paymentMethod = giftCardPaymentMethod;

        try {
          await giftcard.processOrder(order);
          throw Error('Process should not be executed...');
        } catch (error) {
          expect(error).to.exist;
          expect(error.toString()).to.contain('Order amount exceeds balance');
        }
      }); /** End Of "Order should NOT be executed because its amount exceeds the balance of the gift card" */

      it('Order should NOT be executed because the gift card has not enough balance', async () => {
        expect(giftCardPaymentMethod.SourcePaymentMethodId).to.be.equal(paymentMethod1.id);
        const order = await models.Order.create({
          CreatedByUserId: user.id,
          FromCollectiveId: userCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: giftCardPaymentMethod.id,
          totalAmount: 10000,
          currency: 'USD',
        });
        order.fromCollective = userCollective;
        order.collective = collective2;
        order.createdByUser = user;
        order.paymentMethod = giftCardPaymentMethod;

        try {
          // should succeed because card has balance
          await giftcard.processOrder(order);
          // should fail because gift card has $0 balance
          await giftcard.processOrder(order);
          throw Error('Process should not be executed...');
        } catch (error) {
          expect(error).to.exist;
          expect(error.toString()).to.contain('This payment method has no balance to complete this order');
        }
      }); /** End Of "Order should NOT be executed because its amount exceeds the balance of the gift card" */

      it('Order should NOT be executed because its amount exceeds the balance with transactions of different currencies', async () => {
        expect(giftCardPaymentMethod.SourcePaymentMethodId).to.be.equal(paymentMethod1.id);
        const orderEUR = await models.Order.create({
          CreatedByUserId: user.id,
          FromCollectiveId: userCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: giftCardPaymentMethod.id,
          totalAmount: 5000,
          currency: 'EUR',
        });
        const orderUSD = await models.Order.create({
          CreatedByUserId: user.id,
          FromCollectiveId: userCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: giftCardPaymentMethod.id,
          totalAmount: 9000,
          currency: 'USD',
        });
        orderEUR.fromCollective = orderUSD.fromCollective = userCollective;
        orderEUR.collective = orderUSD.collective = collective2;
        orderEUR.createdByUser = orderUSD.createdByUser = user;
        orderEUR.paymentMethod = orderUSD.paymentMethod = giftCardPaymentMethod;
        try {
          // executing order in USD, has balance
          await giftcard.processOrder(orderEUR);
          // executing order in EUR, still has balance
          await giftcard.processOrder(orderUSD);
          throw Error('Process should not be executed...');
        } catch (error) {
          expect(error).to.exist;
          expect(error.toString()).to.contain('Order amount exceeds balance');
        }
      }); /** End Of "Order should NOT be executed because its amount exceeds the balance with transactions of different currencies" */

      it('Process order of a gift card', async () => {
        const order = await models.Order.create({
          CreatedByUserId: user.id,
          FromCollectiveId: userCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: giftCardPaymentMethod.id,
          totalAmount: ORDER_TOTAL_AMOUNT,
          currency: 'USD',
        });
        order.fromCollective = userCollective;
        order.collective = collective2;
        order.createdByUser = user;
        order.paymentMethod = giftCardPaymentMethod;

        const giftCardEmitterCollectiveId = paymentMethod1.CollectiveId;

        // checking if transaction generated(CREDIT) matches the correct payment method
        // amount, currency and collectives...
        const creditTransaction = await giftcard.processOrder(order);
        expect(creditTransaction.type).to.be.equal('CREDIT');
        expect(creditTransaction.PaymentMethodId).to.be.equal(giftCardPaymentMethod.id);
        expect(creditTransaction.UsingGiftCardFromCollectiveId).to.be.equal(giftCardEmitterCollectiveId);
        expect(creditTransaction.FromCollectiveId).to.be.equal(userCollective.id);
        expect(creditTransaction.CollectiveId).to.be.equal(collective2.id);
        expect(creditTransaction.amount).to.be.equal(ORDER_TOTAL_AMOUNT);
        expect(creditTransaction.amountInHostCurrency).to.be.equal(ORDER_TOTAL_AMOUNT);
        expect(creditTransaction.currency).to.be.equal('USD');
        expect(creditTransaction.hostCurrency).to.be.equal('USD');
        // checking balance of gift card(should be initial balance - order amount)
        const giftCardBalance = await giftcard.getBalance(giftCardPaymentMethod);
        expect(giftCardBalance.amount).to.be.equal(giftCardPaymentMethod.initialBalance - ORDER_TOTAL_AMOUNT);
        // User should now be a member of collective
        const userMember = models.Member.findOne({
          where: {
            CollectiveId: collective2.id,
            MemberCollectiveId: userCollective.id,
          },
        });
        expect(userMember).to.exist;

        // Collective that emitted the gift card should be a member too
        const collectiveMember = models.Member.findOne({
          where: {
            CollectiveId: collective2.id,
            MemberCollectiveId: giftCardEmitterCollectiveId,
          },
        });
        expect(collectiveMember).to.exist;
      }); /** End Of "Process order of a gift card" */

      describe('if the transaction fails', () => {
        let creditCardProcessOrderMock;

        beforeEach(() => {
          creditCardProcessOrderMock = stub(creditCardLib, 'processOrder');
        });

        afterEach(() => {
          creditCardProcessOrderMock.restore();
        });

        it('does not mess up with the PaymentMethodId', async () => {
          const order = await fakeOrder({ PaymentMethodId: giftCardPaymentMethod.id, totalAmount: 100 });
          creditCardProcessOrderMock.callsFake(order =>
            order.save().then(() => {
              throw new Error();
            }),
          );

          try {
            await giftcard.processOrder(order);
          } catch {
            // Ignore error
          }

          await order.reload();
          expect(order.PaymentMethodId).to.eq(giftCardPaymentMethod.id);
        });
      });
    }); /** End Of "#processOrder" */

    describe('#refundTransaction', () => {
      const INITIAL_BALANCE = 5000;
      const CURRENCY = 'USD';
      let user = null;
      let hostCollective = null;
      let targetCollective = null;
      let sourcePm = null;
      let giftCardPm = null;

      before(async () => {
        hostCollective = await models.Collective.create({
          type: 'ORGANIZATION',
          name: 'Test HOST',
          currency: CURRENCY,
          isActive: true,
          approvedAt: new Date(),
        });
        await store.stripeConnectedAccount(hostCollective.id);
      });

      before(async () => {
        user = await models.User.createUserWithCollective({
          name: 'Test Prepaid Donator',
          email: store.randEmail('prepaid-donator@opencollective.com'),
        });
      });

      before(
        'create a credit card payment method',
        async () =>
          (sourcePm = await models.PaymentMethod.create({
            name: '4242',
            service: 'stripe',
            type: 'creditcard',
            token: 'tok_123456781234567812345678',
            CollectiveId: user.collective.id,
            monthlyLimitPerMember: null,
          })),
      );

      before(async () => {
        targetCollective = await models.Collective.create({
          name: 'Test Collective',
          currency: CURRENCY,
          isActive: true,
          approvedAt: new Date(),
        }).then(c => (targetCollective = c));
        await targetCollective.addHost(hostCollective, user, { shouldAutomaticallyApprove: true });
      });

      before(async () => {
        giftCardPm = await models.PaymentMethod.create({
          name: 'Test VC',
          SourcePaymentMethodId: sourcePm.id,
          initialBalance: INITIAL_BALANCE,
          monthlyLimitPerMember: null,
          currency: CURRENCY,
          CollectiveId: user.collective.id,
          customerId: user.id,
          data: { HostCollectiveId: hostCollective.id },
          service: 'opencollective',
          type: 'giftcard',
          createdAt: new Date(),
          updatedAt: new Date(),
          expiryDate: new Date(2042, 22, 10),
        });
      });

      it('refunds transaction and restore balance', async () => {
        const initialBalance = await giftcard.getBalance(giftCardPm);
        const order = await fakeOrder({
          CreatedByUserId: user.id,
          FromCollectiveId: user.collective.id,
          CollectiveId: targetCollective.id,
          PaymentMethodId: giftCardPm.id,
          totalAmount: 1000,
          currency: 'USD',
        });

        const transaction = await giftcard.processOrder(order);
        expect(transaction).to.exist;

        // Check balance decreased
        const balanceAfterOrder = await giftcard.getBalance(giftCardPm);
        expect(balanceAfterOrder.amount).to.be.equal(initialBalance.amount - 1000);

        // Make refund
        await giftcard.refundTransaction(transaction, user);
        const balanceAfterRefund = await giftcard.getBalance(giftCardPm);
        expect(balanceAfterRefund.amount).to.be.equal(initialBalance.amount);
      });
    });
  }); /** End Of "paymentProviders.opencollective.giftcard" */

  describe('graphql.mutations.paymentMethods.giftcard', () => {
    describe('#processOrder2', async () => {
      let host1,
        host2,
        collective1,
        collective2,
        giftCardPaymentMethod,
        sourcePaymentMethod,
        user1,
        userGiftCard,
        userGiftCardCollective;

      before(() => utils.resetTestDB());

      before('create Host 1(USD)', () =>
        models.Collective.create({
          name: 'Host 1',
          currency: 'USD',
          isActive: true,
          approvedAt: new Date(),
        }).then(c => {
          host1 = c;
          // Create stripe connected account to host
          return store.stripeConnectedAccount(host1.id);
        }),
      );
      before('create Host 2(USD)', () =>
        models.Collective.create({
          name: 'Host 2',
          currency: 'USD',
          isActive: true,
          approvedAt: new Date(),
        }).then(c => {
          host2 = c;
          // Create stripe connected account to host
          return store.stripeConnectedAccount(host2.id);
        }),
      );
      before('create collective1', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          isActive: true,
          approvedAt: new Date(),
          tags: ['open source'],
        }).then(c => (collective1 = c)),
      );
      before('create collective2', () =>
        models.Collective.create({
          name: 'collective2',
          currency: 'USD',
          isActive: true,
          approvedAt: new Date(),
          tags: ['meetup'],
        }).then(c => (collective2 = c)),
      );
      before('creates User 1', () =>
        models.User.createUserWithCollective({
          email: store.randEmail(),
          name: 'User 1',
        }).then(u => (user1 = u)),
      );
      before('add hosts', async () => {
        await collective1.addHost(host1, user1, { shouldAutomaticallyApprove: true });
        await collective2.addHost(host2, user1, { shouldAutomaticallyApprove: true });
      });
      before('user1 to become Admin of collective1', () => {
        return models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: 'ADMIN',
        }).then(() => {
          user1.populateRoles();
        });
      });
      before('create a credit card payment method', () =>
        models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: null,
        }).then(pm => (sourcePaymentMethod = pm)),
      );

      before('create a claimed gift card payment method', async () => {
        userGiftCard = await models.User.createUserWithCollective({
          email: store.randEmail('giftcard-claimer@opencollective.com'),
          name: 'Gift Card Claimer',
        });
        userGiftCardCollective = userGiftCard.collective;
        giftCardPaymentMethod = await models.PaymentMethod.create({
          name: 'gift card test',
          description: 'gift card test',
          SourcePaymentMethodId: sourcePaymentMethod.id,
          initialBalance: 10000,
          monthlyLimitPerMember: null,
          currency: 'USD',
          CollectiveId: userGiftCardCollective.id,
          CreatedByUserId: user1.id,
          service: 'opencollective',
          type: 'giftcard',
          confirmedAt: new Date(),
          expiryDate: moment().add(24, 'months').toDate(),
          limitedToTags: ['open source'],
          limitedToHostCollectiveIds: [host1.id],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      });

      it('Order should NOT be executed because its amount exceeds the balance of the gift card', async () => {
        // Setting up order
        const order = {
          fromAccount: { legacyId: userGiftCard.CollectiveId },
          toAccount: { legacyId: collective1.id },
          paymentMethod: { id: idEncode(giftCardPaymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
          amount: { valueInCents: 1000000, currency: 'USD' },
          frequency: 'ONETIME',
        };
        // Executing queries
        const gqlResult = await utils.graphqlQueryV2(createOrderMutation, { order }, userGiftCard);
        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain("You don't have enough funds available");
      }); /** End Of "Order should NOT be executed because its amount exceeds the balance of the gift card" */

      it('Order should NOT be executed because the gift card is limited to be used on collectives with tag open source', async () => {
        // Setting up order
        const order = {
          fromAccount: { legacyId: userGiftCard.CollectiveId },
          toAccount: { legacyId: collective2.id },
          paymentMethod: { id: idEncode(giftCardPaymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
          amount: { valueInCents: 1000, currency: 'USD' },
          frequency: 'ONETIME',
        };
        // Executing queries
        const gqlResult = await utils.graphqlQueryV2(createOrderMutation, { order }, userGiftCard);
        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain(
          'This payment method can only be used for collectives in open source',
        );
      });

      it('updateOrder should NOT switch to gift card limited by tags', async () => {
        const stripePm = await models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: userGiftCardCollective.id,
          CreatedByUserId: userGiftCard.id,
        });
        const subscription = await models.Subscription.create({
          CollectiveId: collective2.id,
          amount: 1000,
          currency: 'USD',
          interval: 'month',
          isActive: true,
        });
        const recurringOrder = await models.Order.create({
          CreatedByUserId: userGiftCard.id,
          FromCollectiveId: userGiftCardCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: stripePm.id,
          SubscriptionId: subscription.id,
          totalAmount: 1000,
          currency: 'USD',
          interval: 'month',
          status: 'ACTIVE',
        });

        const gqlResult = await utils.graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(recurringOrder.id, IDENTIFIER_TYPES.ORDER) },
            paymentMethod: { id: idEncode(giftCardPaymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
          },
          userGiftCard,
        );
        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0].toString()).to.contain(
          'This payment method can only be used for collectives in open source',
        );
        await recurringOrder.reload();
        expect(recurringOrder.PaymentMethodId).to.equal(stripePm.id);
      });

      it('Order should NOT be executed because the gift card is limited to be used on another host', async () => {
        // Setting up order
        await giftCardPaymentMethod.update({ limitedToTags: null });
        const order = {
          fromAccount: { legacyId: userGiftCard.CollectiveId },
          toAccount: { legacyId: collective2.id },
          paymentMethod: { id: idEncode(giftCardPaymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
          amount: { valueInCents: 1000, currency: 'USD' },
          frequency: 'ONETIME',
        };
        // Executing queries
        const gqlResult = await utils.graphqlQueryV2(createOrderMutation, { order }, userGiftCard);
        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain(
          'This payment method can only be used for collectives hosted by Host 1',
        );
      });

      it('updateOrder should NOT switch to gift card limited to another host', async () => {
        await giftCardPaymentMethod.update({ limitedToTags: null });

        const stripePm = await models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: userGiftCardCollective.id,
          CreatedByUserId: userGiftCard.id,
        });
        const subscription = await models.Subscription.create({
          CollectiveId: collective2.id,
          amount: 1000,
          currency: 'USD',
          interval: 'month',
          isActive: true,
        });
        const recurringOrder = await models.Order.create({
          CreatedByUserId: userGiftCard.id,
          FromCollectiveId: userGiftCardCollective.id,
          CollectiveId: collective2.id,
          PaymentMethodId: stripePm.id,
          SubscriptionId: subscription.id,
          totalAmount: 1000,
          currency: 'USD',
          interval: 'month',
          status: 'ACTIVE',
        });

        const gqlResult = await utils.graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(recurringOrder.id, IDENTIFIER_TYPES.ORDER) },
            paymentMethod: { id: idEncode(giftCardPaymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
          },
          userGiftCard,
        );
        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0].toString()).to.contain(
          'This payment method can only be used for collectives hosted by Host 1',
        );
        await recurringOrder.reload();
        expect(recurringOrder.PaymentMethodId).to.equal(stripePm.id);
      });

      it('Process order of a gift card', async () => {
        // Setting up order
        const order = {
          fromAccount: { legacyId: userGiftCard.CollectiveId },
          toAccount: { legacyId: collective1.id },
          paymentMethod: { id: idEncode(giftCardPaymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
          amount: { valueInCents: ORDER_TOTAL_AMOUNT, currency: 'USD' },
          frequency: 'ONETIME',
        };
        // Executing queries
        const gqlResult = await utils.graphqlQueryV2(createOrderMutation, { order }, userGiftCard);

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.undefined;

        const transactions = await models.Transaction.findAll({
          where: { OrderId: gqlResult.data.createOrder.order.legacyId },
          order: [['id', 'DESC']],
          limit: 2,
        });
        // checking if transaction generated(CREDIT) matches the correct payment method
        // amount, currency and collectives...
        const creditTransaction = transactions[0];
        expect(creditTransaction.type).to.be.equal('CREDIT');
        expect(creditTransaction.PaymentMethodId).to.be.equal(giftCardPaymentMethod.id);
        expect(creditTransaction.FromCollectiveId).to.be.equal(userGiftCard.CollectiveId);
        expect(creditTransaction.CollectiveId).to.be.equal(collective1.id);
        expect(creditTransaction.amount).to.be.equal(ORDER_TOTAL_AMOUNT);
        expect(creditTransaction.amountInHostCurrency).to.be.equal(ORDER_TOTAL_AMOUNT);
        expect(creditTransaction.currency).to.be.equal('USD');
        expect(creditTransaction.hostCurrency).to.be.equal('USD');
        // checking balance of gift card(should be initial balance - order amount)
        const giftCardBalance = await giftcard.getBalance(giftCardPaymentMethod);
        expect(giftCardBalance.amount).to.be.equal(giftCardPaymentMethod.initialBalance - ORDER_TOTAL_AMOUNT);
      }); /** End Of "Process order of a gift card" */

      it('should fail when multiple orders exceed the balance of the gift card', async () => {
        // Setting up order
        const order = {
          fromAccount: { legacyId: userGiftCard.CollectiveId },
          toAccount: { legacyId: collective1.id },
          paymentMethod: { id: idEncode(giftCardPaymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
          amount: { valueInCents: ORDER_TOTAL_AMOUNT, currency: 'USD' },
          frequency: 'ONETIME',
        };
        // Executing queries that overstep gift card balance
        await utils.graphqlQueryV2(createOrderMutation, { order }, userGiftCard);
        await utils.graphqlQueryV2(createOrderMutation, { order }, userGiftCard);
        const gqlResult = await utils.graphqlQueryV2(createOrderMutation, { order }, userGiftCard);

        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain("You don't have enough funds available");
      }); /** End Of "should fail when multiple orders exceed the balance of the gift card" */
    }); /** End Of "#processOrder" */
  }); /** End Of "graphql.mutations.paymentMethods.giftcard" */
});
