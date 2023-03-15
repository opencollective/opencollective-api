import { expect } from 'chai';
import gql from 'fake-tag';
import moment from 'moment';
import nock from 'nock';
import { createSandbox, stub } from 'sinon';

import { maxInteger } from '../../../../server/constants/math';
import emailLib from '../../../../server/lib/email';
import models from '../../../../server/models';
import giftcard from '../../../../server/paymentProviders/opencollective/giftcard';
import creditCardLib from '../../../../server/paymentProviders/stripe/creditcard';
import initNock from '../../../nocks/paymentMethods.opencollective.giftcard.nock';
import * as store from '../../../stores';
import { fakeOrder } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const ORDER_TOTAL_AMOUNT = 5000;
const STRIPE_FEE_STUBBED_VALUE = 300;

const createGiftCardsMutation = gql`
  mutation CreateGiftCards(
    $amount: Int
    $monthlyLimitPerMember: Int
    $CollectiveId: Int!
    $PaymentMethodId: Int
    $description: String
    $expiryDate: String
    $currency: String!
    $limitedToTags: [String]
    $limitedToHostCollectiveIds: [Int]
  ) {
    createGiftCards(
      amount: $amount
      monthlyLimitPerMember: $monthlyLimitPerMember
      CollectiveId: $CollectiveId
      PaymentMethodId: $PaymentMethodId
      description: $description
      expiryDate: $expiryDate
      currency: $currency
      limitedToTags: $limitedToTags
      limitedToHostCollectiveIds: $limitedToHostCollectiveIds
      numberOfGiftCards: 1
    ) {
      id
      name
      uuid
      collective {
        id
      }
      initialBalance
      monthlyLimitPerMember
      expiryDate
      currency
      limitedToTags
      limitedToHostCollectiveIds
    }
  }
`;

const claimPaymentMethodMutation = gql`
  mutation ClaimPaymentMethod($user: UserInputType, $code: String!) {
    claimPaymentMethod(user: $user, code: $code) {
      id
      expiryDate
      collective {
        id
        slug
        name
        twitterHandle
      }
    }
  }
`;

const createOrderMutation = gql`
  mutation CreateOrder($order: OrderInputType!) {
    createOrder(order: $order) {
      id
      fromCollective {
        id
        slug
      }
      collective {
        id
        slug
      }
      subscription {
        id
        amount
        interval
        isActive
        stripeSubscriptionId
      }
      totalAmount
      currency
      description
    }
  }
`;

describe('server/paymentProviders/opencollective/giftcard', () => {
  let sandbox, sendEmailSpy;

  before(initNock);
  after(() => {
    nock.cleanAll();
  });

  beforeEach(() => {
    sandbox = createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    // And given that the endpoint for creating customers on Stripe
    // is patched
    utils.stubStripeCreate(sandbox, {
      charge: { currency: 'usd', status: 'succeeded' },
    });
    // And given the stripe stuff that depends on values in the
    // order struct is patch. It's here and not on each test because
    // the `totalAmount' field doesn't change throught the tests.
    utils.stubStripeBalance(sandbox, ORDER_TOTAL_AMOUNT, 'usd', 0, STRIPE_FEE_STUBBED_VALUE); // This is the payment processor fee.
  });

  afterEach(() => sandbox.restore());

  describe('paymentProviders.opencollective.giftcard', () => {
    describe('#create', async () => {
      let collective1, user1;

      before(() => utils.resetTestDB());
      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          isActive: true,
          approvedAt: new Date(),
        }).then(c => (collective1 = c)),
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
          user1.populateRoles();
        });
      });
      before('create a payment method', () =>
        models.PaymentMethod.create({
          name: '4242',
          service: 'stripe',
          type: 'creditcard',
          token: 'tok_123456781234567812345678',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: null,
        }),
      );

      it('should create a U$100 gift card payment method', async () => {
        const args = {
          description: 'gift card test',
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
        };
        const paymentMethod = await giftcard.create(args, user1);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.initialBalance).to.be.equal(args.amount);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('giftcard');
        expect(moment(paymentMethod.expiryDate).format('YYYY-MM-DD')).to.be.equal(
          moment().add(24, 'months').format('YYYY-MM-DD'),
        );
        expect(paymentMethod.description).to.be.equal(args.description);
      }); /** End Of "should create a U$100 gift card payment method" */

      it('should create a U$100 gift card payment method defining an expiry date', async () => {
        const expiryDate = moment().add(6, 'months').format('YYYY-MM-DD');
        const args = {
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
          expiryDate: expiryDate,
        };
        const paymentMethod = await giftcard.create(args, user1);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.initialBalance).to.be.equal(args.amount);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('giftcard');
        expect(moment(paymentMethod.expiryDate).format('YYYY-MM-DD')).to.be.equal(expiryDate);
        expect(paymentMethod.description).to.contain('Gift Card from');
        expect(paymentMethod.description).to.not.contain('Monthly Gift Card');
      }); /** End Of "should create a U$100 gift card payment method defining an expiry date" */

      it('should create a gift card with monthly limit member of U$100 per month', async () => {
        const args = {
          CollectiveId: collective1.id,
          monthlyLimitPerMember: 10000,
          currency: 'USD',
        };
        const paymentMethod = await giftcard.create(args, user1);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('giftcard');
        expect(moment(paymentMethod.expiryDate).format('YYYY-MM-DD')).to.be.equal(
          moment().add(24, 'months').format('YYYY-MM-DD'),
        );
        expect(paymentMethod.monthlyLimitPerMember).to.be.equal(args.monthlyLimitPerMember);
        // if there is a monthlyLimitPerMember balance must not exist
        expect(paymentMethod.balance).to.not.exist;
        expect(paymentMethod.description).to.contain('Monthly Gift Card from');
      }); /** End Of "should create a gift card with monthly limit member of U$100 per month" */

      it('should create a gift card with monthly limit member of U$100 per month defining an expiry date', async () => {
        const expiryDate = moment().add(6, 'months').format('YYYY-MM-DD');
        const args = {
          description: 'gift card test',
          CollectiveId: collective1.id,
          monthlyLimitPerMember: 10000,
          currency: 'USD',
          expiryDate: expiryDate,
        };
        const paymentMethod = await giftcard.create(args, user1);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('giftcard');
        expect(moment(paymentMethod.expiryDate).format('YYYY-MM-DD')).to.be.equal(expiryDate);
        expect(paymentMethod.monthlyLimitPerMember).to.be.equal(args.monthlyLimitPerMember);
        // if there is a monthlyLimitPerMember balance must not exist
        expect(paymentMethod.balance).to.not.exist;
      }); /** End Of "should create a gift card with monthly limit member of U$100 per month defining an expiry date" */
    }); /** End Of "#create" */

    describe('#claim', async () => {
      let collective1, paymentMethod1, user1, giftCardPaymentMethod;

      before(() => utils.resetTestDB());
      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          isActive: true,
          approvedAt: new Date(),
        }).then(c => (collective1 = c)),
      );
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

      before('creates User 1', () =>
        models.User.createUserWithCollective({
          email: store.randEmail(),
          name: 'User 1',
        }).then(u => (user1 = u)),
      );

      before('user1 to become Admin of collective1', () =>
        models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: 'ADMIN',
        }).then(() => user1.populateRoles()),
      );

      before('create a gift card payment method', () => {
        const createParams = {
          description: 'gift card test',
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
        };
        return giftcard.create(createParams, user1).then(pm => (giftCardPaymentMethod = pm));
      });

      it('new User should claim a gift card', async () => {
        // setting correct code to claim gift card by new User
        const giftCardCode = giftCardPaymentMethod.uuid.substring(0, 8);
        const args = {
          user: { email: 'new@user.com' },
          code: giftCardCode,
        };
        // claim gift card
        const paymentMethod = await giftcard.claim(args);
        // payment method should exist
        expect(paymentMethod).to.exist;
        // then paymentMethod SourcePaymentMethodId should be paymentMethod1.id(the PM of the organization collective1)
        expect(paymentMethod.SourcePaymentMethodId).to.be.equal(paymentMethod1.id);
        // and collective id of "original" gift card should be different than the one returned
        expect(giftCardPaymentMethod.CollectiveId).not.to.be.equal(paymentMethod.CollectiveId);
        // then find collective of created user
        const userCollective = await models.Collective.findByPk(paymentMethod.CollectiveId);
        // then find the user
        const user = await models.User.findOne({
          where: {
            CollectiveId: userCollective.id,
          },
        });
        // then check if the user email matches the email on the argument used on the claim
        expect(user.email).to.be.equal(args.user.email);
        // then check if both have the same uuid
        expect(paymentMethod.uuid).not.to.be.equal(giftCardPaymentMethod.id);
        // and check if both have the same expiry
        expect(moment(paymentMethod.expiryDate).format()).to.be.equal(
          moment(giftCardPaymentMethod.expiryDate).format(),
        );
      }); /** End Of "new User should claim a gift card" */
    }); /** End Of "#claim" */

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

      beforeEach('create a gift card payment method', () =>
        giftcard
          .create(
            {
              description: 'gift card test',
              CollectiveId: collective1.id,
              amount: 10000,
              currency: 'USD',
            },
            user1,
          )
          .then(pm => (giftCardPaymentMethod = pm)),
      );

      beforeEach('new user claims a gift card', () =>
        giftcard
          .claim({
            user: { email: 'new@user.com' },
            code: giftCardPaymentMethod.uuid.substring(0, 8),
          })
          .then(async pm => {
            giftCardPaymentMethod = await models.PaymentMethod.findByPk(pm.id);
            userCollective = await models.Collective.findByPk(giftCardPaymentMethod.CollectiveId);
            user = await models.User.findOne({
              where: {
                CollectiveId: userCollective.id,
              },
            });
          }),
      );

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
    describe('#create', async () => {
      let collective1, collective2, creditCard2, user1;

      before(() => utils.resetTestDB());
      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          type: 'ORGANIZATION',
          currency: 'USD',
          isActive: true,
          approvedAt: new Date(),
        }).then(c => (collective1 = c)),
      );
      before('create collective2(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective2',
          currency: 'USD',
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
      before('user1 to become Admin of collective1', () =>
        models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: 'ADMIN',
        }),
      );
      before('create a payment method for collective 1', () => store.createCreditCard(collective1.id));
      before('create a payment method for collective 2', () =>
        store.createCreditCard(collective2.id).then(c => (creditCard2 = c)),
      );

      it('should fail creating a gift card because there is no currency defined', async () => {
        const args = { CollectiveId: collective1.id, amount: 10000 };
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(createGiftCardsMutation, args, user1);
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain('"$currency" of required type "String!" was not provided.');
      }); /** End of "should fail creating a gift card because there is no currency defined" */

      it('should fail creating a gift card because there is no amount or monthlyLimitPerMember defined', async () => {
        const args = {
          currency: 'USD',
          CollectiveId: collective1.id,
        };
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(createGiftCardsMutation, args, user1);
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain(
          'you need to define either the amount or the monthlyLimitPerMember of the payment method.',
        );
      }); /** End of "should fail creating a gift card because there is amount or monthlyLimitPerMember defined" */

      it('should create a U$100 gift card payment method limited to open source', async () => {
        const args = {
          CollectiveId: collective1.id,
          amount: 10000,
          currency: 'USD',
          limitedToTags: ['open source'],
        };
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(createGiftCardsMutation, args, user1);

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.undefined;

        const paymentMethod = await models.PaymentMethod.findByPk(gqlResult.data.createGiftCards[0].id);
        expect(paymentMethod).to.exist;
        expect(paymentMethod.limitedToTags).to.contain('open source');
        expect(paymentMethod.CreatedByUserId).to.be.equal(user1.id);
        expect(paymentMethod.CollectiveId).to.be.equal(collective1.id);
        expect(paymentMethod.initialBalance).to.be.equal(args.amount);
        expect(paymentMethod.service).to.be.equal('opencollective');
        expect(paymentMethod.type).to.be.equal('giftcard');
        expect(moment(paymentMethod.expiryDate).format('YYYY-MM-DD')).to.be.equal(
          moment().add(24, 'months').format('YYYY-MM-DD'),
        );
      }); /** End of "should create a U$100 gift card payment method" */

      it("should fail if payment method does't belongs to collective", async () => {
        const args = {
          currency: 'USD',
          CollectiveId: collective1.id,
          amount: 10000,
          PaymentMethodId: creditCard2.id,
        };
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(createGiftCardsMutation, args, user1);
        expect(gqlResult.errors).to.exist;
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain('Invalid PaymentMethodId');
      });
    }); /** End Of "#create" */

    describe('#claim', async () => {
      let collective1, paymentMethod1, giftCardPaymentMethod, user1;

      before(() => utils.resetTestDB());

      before('create collective1(currency USD, No Host)', () =>
        models.Collective.create({
          name: 'collective1',
          currency: 'USD',
          image: 'https://cldup.com/rdmBCmH20l.png',
          isActive: true,
          approvedAt: new Date(),
        }).then(c => (collective1 = c)),
      );

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

      beforeEach('create a gift card payment method', () =>
        giftcard
          .create(
            {
              description: 'gift card test',
              CollectiveId: collective1.id,
              amount: 10000,
              currency: 'USD',
            },
            user1,
          )
          .then(pm => (giftCardPaymentMethod = pm)),
      );

      it('new User should claim a gift card', async () => {
        // setting correct code to claim gift card by new User
        const giftCardCode = giftCardPaymentMethod.uuid.substring(0, 8);
        const args = {
          user: {
            name: 'New User',
            email: 'new@user.com',
            twitterHandle: 'xdamman',
          },
          code: giftCardCode,
        };
        // claim gift card
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(claimPaymentMethodMutation, args);

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.undefined;

        const paymentMethod = gqlResult.data.claimPaymentMethod;
        // payment method should exist
        expect(paymentMethod).to.exist;
        // then paymentMethod SourcePaymentMethodId should be paymentMethod1.id(the PM of the organization collective1)
        const pmFromDb = await models.PaymentMethod.findByPk(paymentMethod.id);
        expect(pmFromDb.SourcePaymentMethodId).to.equal(paymentMethod1.id);
        expect(paymentMethod.collective.name).to.equal(args.user.name);
        expect(paymentMethod.collective.twitterHandle).to.equal(args.user.twitterHandle);
        // and collective id of "original" gift card should be different than the one returned
        expect(giftCardPaymentMethod.CollectiveId).not.to.equal(paymentMethod.collective.id);
        // then find collective of created user
        const userCollective = paymentMethod.collective;

        // then find the user
        const user = await models.User.findOne({
          where: {
            CollectiveId: userCollective.id,
          },
        });
        // then check if the user email matches the email on the argument used on the claim
        expect(user.email).to.be.equal(args.user.email);
        // then check if both have the same uuid
        expect(paymentMethod.uuid).not.to.be.equal(giftCardPaymentMethod.id);
        // and check if both have the same expiry
        expect(moment(new Date(paymentMethod.expiryDate)).format()).to.be.equal(
          moment(giftCardPaymentMethod.expiryDate).format(),
        );

        await utils.waitForCondition(() => sendEmailSpy.callCount > 0);
        expect(sendEmailSpy.firstCall.args[0]).to.equal(args.user.email);
        expect(sendEmailSpy.firstCall.args[1]).to.contain(
          `You've got $100.00 from collective1 to spend on Open Collective`,
        );
        expect(sendEmailSpy.firstCall.args[2]).to.contain(`next=/redeemed?code=${giftCardCode}`);
        expect(sendEmailSpy.firstCall.args[2]).to.contain(
          collective1.image.substr(collective1.image.lastIndexOf('/') + 1),
        );
      }); /** End Of "#new User should claim a gift card" */

      it('Existing User should claim a gift card', async () => {
        const existingUser = await models.User.createUserWithCollective({
          email: store.randEmail(),
          name: 'Existing User',
        });
        // setting correct code to claim gift card by new User
        const giftCardCode = giftCardPaymentMethod.uuid.substring(0, 8);
        const args = {
          code: giftCardCode,
        };
        // claim gift card
        // call graphql mutation
        const gqlResult = await utils.graphqlQuery(claimPaymentMethodMutation, args, existingUser);

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.undefined;

        const paymentMethod = await models.PaymentMethod.findByPk(gqlResult.data.claimPaymentMethod.id);

        // payment method should exist
        expect(paymentMethod).to.exist;
        // then paymentMethod SourcePaymentMethodId should be paymentMethod1.id(the PM of the organization collective1)
        expect(paymentMethod.SourcePaymentMethodId).to.be.equal(paymentMethod1.id);
        // and collective id of "original" gift card should be different than the one returned
        expect(giftCardPaymentMethod.CollectiveId).not.to.be.equal(paymentMethod.CollectiveId);
        // then find collective of created user
        const userCollective = await models.Collective.findByPk(paymentMethod.CollectiveId);
        // then find the user
        const user = await models.User.findOne({
          where: {
            CollectiveId: userCollective.id,
          },
        });
        // compare user from collectiveId on payment method to existingUser(that claimend)
        expect(user.email).to.be.equal(existingUser.email);
        expect(userCollective.id).to.be.equal(existingUser.CollectiveId);
        // then check if both have the same uuid
        expect(paymentMethod.uuid).not.to.be.equal(giftCardPaymentMethod.id);
        // and check if both have the same expiry
        expect(moment(paymentMethod.expiryDate).format()).to.be.equal(
          moment(giftCardPaymentMethod.expiryDate).format(),
        );
      }); /** End Of "Existing User should claim a gift card" */
    }); /** End Of "#claim" */

    describe('#processOrder2', async () => {
      let host1, host2, collective1, collective2, giftCardPaymentMethod, user1, userGiftCard, userGiftCardCollective;

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
        }),
      );

      before('create a gift card payment method', () =>
        giftcard
          .create(
            {
              description: 'gift card test',
              CollectiveId: collective1.id,
              amount: 10000,
              currency: 'USD',
              limitedToHostCollectiveIds: [host1.id],
              limitedToTags: ['open source'],
            },
            user1,
          )
          .then(pm => (giftCardPaymentMethod = pm)),
      );

      before('new user claims a gift card', () =>
        giftcard
          .claim({
            user: { email: 'new@user.com' },
            code: giftCardPaymentMethod.uuid.substring(0, 8),
          })
          .then(async pm => {
            giftCardPaymentMethod = await models.PaymentMethod.findByPk(pm.id);
            userGiftCardCollective = await models.Collective.findByPk(giftCardPaymentMethod.CollectiveId);
            userGiftCard = await models.User.findOne({
              where: {
                CollectiveId: userGiftCardCollective.id,
              },
            });
          }),
      );

      it('Order should NOT be executed because its amount exceeds the balance of the gift card', async () => {
        // Setting up order
        const order = {
          fromCollective: { id: userGiftCard.CollectiveId },
          collective: { id: collective1.id },
          paymentMethod: { uuid: giftCardPaymentMethod.uuid },
          totalAmount: 1000000,
        };
        // Executing queries
        const gqlResult = await utils.graphqlQuery(createOrderMutation, { order }, userGiftCard);
        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain("You don't have enough funds available");
      }); /** End Of "Order should NOT be executed because its amount exceeds the balance of the gift card" */

      it('Order should NOT be executed because the gift card is limited to be used on collectives with tag open source', async () => {
        // Setting up order
        const order = {
          fromCollective: { id: userGiftCard.CollectiveId },
          collective: { id: collective2.id },
          paymentMethod: { uuid: giftCardPaymentMethod.uuid },
          totalAmount: 1000,
        };
        // Executing queries
        const gqlResult = await utils.graphqlQuery(createOrderMutation, { order }, userGiftCard);
        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain(
          'This payment method can only be used for collectives in open source',
        );
      });

      it('Order should NOT be executed because the gift card is limited to be used on another host', async () => {
        // Setting up order
        await giftCardPaymentMethod.update({ limitedToTags: null });
        const order = {
          fromCollective: { id: userGiftCard.CollectiveId },
          collective: { id: collective2.id },
          paymentMethod: { uuid: giftCardPaymentMethod.uuid },
          totalAmount: 1000,
        };
        // Executing queries
        const gqlResult = await utils.graphqlQuery(createOrderMutation, { order }, userGiftCard);
        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain(
          'This payment method can only be used for collectives hosted by Host 1',
        );
      });

      it('Process order of a gift card', async () => {
        // Setting up order
        const order = {
          fromCollective: { id: userGiftCard.CollectiveId },
          collective: { id: collective1.id },
          paymentMethod: { uuid: giftCardPaymentMethod.uuid },
          totalAmount: ORDER_TOTAL_AMOUNT,
        };
        // Executing queries
        const gqlResult = await utils.graphqlQuery(createOrderMutation, { order }, userGiftCard);

        gqlResult.errors && console.error(gqlResult.errors[0]);
        expect(gqlResult.errors).to.be.undefined;

        const transactions = await models.Transaction.findAll({
          where: {
            OrderId: gqlResult.data.createOrder.id,
          },
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
          fromCollective: { id: userGiftCard.CollectiveId },
          collective: { id: collective1.id },
          paymentMethod: { uuid: giftCardPaymentMethod.uuid },
          totalAmount: ORDER_TOTAL_AMOUNT,
        };
        // Executing queries that overstep gift card balance
        await utils.graphqlQuery(createOrderMutation, { order }, userGiftCard);
        await utils.graphqlQuery(createOrderMutation, { order }, userGiftCard);
        const gqlResult = await utils.graphqlQuery(createOrderMutation, { order }, userGiftCard);

        expect(gqlResult.errors).to.be.an('array');
        expect(gqlResult.errors[0]).to.exist;
        expect(gqlResult.errors[0].toString()).to.contain("You don't have enough funds available");
      }); /** End Of "should fail when multiple orders exceed the balance of the gift card" */
    }); /** End Of "#processOrder" */
  }); /** End Of "graphql.mutations.paymentMethods.giftcard" */
});
