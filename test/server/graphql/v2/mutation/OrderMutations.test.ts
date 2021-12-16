import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { createSandbox } from 'sinon';

import { roles } from '../../../../../server/constants';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import * as payments from '../../../../../server/lib/payments';
import models from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakeTier,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const CREATE_ORDER_MUTATION = gqlV2/* GraphQL */ `
  mutation CreateOrder($order: OrderCreateInput!) {
    createOrder(order: $order) {
      order {
        id
        legacyId
        status
        quantity
        frequency
        tags
        customData
        tier {
          legacyId
        }
        amount {
          valueInCents
        }
        platformContributionAmount {
          valueInCents
        }
        fromAccount {
          id
          legacyId
          slug
          name
          legalName
          ... on Individual {
            isGuest
          }
        }
        paymentMethod {
          id
          legacyId
          account {
            id
            legacyId
          }
        }
        toAccount {
          legacyId
        }
      }
    }
  }
`;

const updateOrderMutation = gqlV2/* GraphQL */ `
  mutation UpdateOrder(
    $order: OrderReferenceInput!
    $amount: AmountInput
    $tier: TierReferenceInput
    $paymentMethod: PaymentMethodReferenceInput
  ) {
    updateOrder(order: $order, amount: $amount, tier: $tier, paymentMethod: $paymentMethod) {
      id
      status
      amount {
        value
        currency
      }
      tier {
        id
        name
      }
      paymentMethod {
        id
      }
    }
  }
`;

const cancelRecurringContributionMutation = gqlV2/* GraphQL */ `
  mutation CancelRecurringContribution($order: OrderReferenceInput!) {
    cancelOrder(order: $order) {
      id
      status
    }
  }
`;

const processPendingOrderMutation = gqlV2/* GraphQL */ `
  mutation ProcessPendingOrder($action: ProcessOrderAction!, $order: OrderUpdateInput!) {
    processPendingOrder(order: $order, action: $action) {
      id
      status
    }
  }
`;

const callCreateOrder = (params, remoteUser = null) => {
  return graphqlQueryV2(CREATE_ORDER_MUTATION, params, remoteUser);
};

const stubExecuteOrderFn = async (user, order) => {
  let subscription;
  if (order.interval) {
    subscription = await models.Subscription.create({
      amount: order.amount,
      currency: order.currency,
      interval: order.interval,
      isActive: true,
    });
  }

  return order.update({ SubscriptionId: subscription?.id, processedAt: new Date(), status: 'PAID' });
};

describe('server/graphql/v2/mutation/OrderMutations', () => {
  describe('createOrder', () => {
    let fromUser, toCollective, host, validOrderParams, sandbox;

    before(async () => {
      await resetTestDB();
      fromUser = await fakeUser();

      // Stub the payment
      sandbox = createSandbox();
      sandbox.stub(payments, 'executeOrder').callsFake(stubExecuteOrderFn);

      // Add Stripe to host
      host = await fakeHost();
      toCollective = await fakeCollective({ HostCollectiveId: host.id });
      await models.ConnectedAccount.create({ service: 'stripe', token: 'abc', CollectiveId: host.id });

      // Some default params to create a valid order
      validOrderParams = {
        fromAccount: { legacyId: fromUser.CollectiveId },
        toAccount: { legacyId: toCollective.id },
        frequency: 'ONETIME',
        paymentMethod: {
          service: 'STRIPE',
          type: 'CREDITCARD',
          name: '4242',
          creditCardInfo: {
            token: 'tok_123456781234567812345678',
            brand: 'VISA',
            country: 'US',
            expMonth: 11,
            expYear: 2024,
          },
        },
        amount: {
          valueInCents: 5000,
        },
      };
    });

    after(() => {
      sandbox.restore();
    });

    describe('Logged in', () => {
      it('works with basic params', async () => {
        const result = await callCreateOrder({ order: validOrderParams }, fromUser);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        const order = result.data.createOrder.order;
        expect(order.amount.valueInCents).to.eq(5000);
        expect(order.frequency).to.eq('ONETIME');
        expect(order.fromAccount.legacyId).to.eq(fromUser.CollectiveId);
        expect(order.toAccount.legacyId).to.eq(toCollective.id);
      });

      it('supports additional params', async () => {
        const tier = await fakeTier({
          CollectiveId: toCollective.id,
          amount: 5000,
          amountType: 'FIXED',
          interval: 'month',
        });
        const result = await callCreateOrder(
          {
            order: {
              ...validOrderParams,
              frequency: 'MONTHLY',
              tier: { legacyId: tier.id },
              quantity: 3,
              tags: ['wow', 'it', 'supports', 'tags!'],
              customData: {
                message: 'Hello world',
              },
            },
          },
          fromUser,
        );
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        const order = result.data.createOrder.order;
        expect(order.amount.valueInCents).to.eq(5000 * 3);
        expect(order.frequency).to.eq('MONTHLY');
        expect(order.fromAccount.legacyId).to.eq(fromUser.CollectiveId);
        expect(order.toAccount.legacyId).to.eq(toCollective.id);
        expect(order.quantity).to.eq(3);
        expect(order.tier.legacyId).to.eq(tier.id);
        expect(order.tags).to.deep.eq(['wow', 'it', 'supports', 'tags!']);
        expect(order.customData).to.deep.eq({ message: 'Hello world' });
      });

      it('can add platform contribution', async () => {
        const collectiveWithoutPlaformFee = await fakeCollective({ platformFeePercent: 0, HostCollectiveId: host.id });
        const result = await callCreateOrder(
          {
            order: {
              ...validOrderParams,
              toAccount: { legacyId: collectiveWithoutPlaformFee.id },
              platformContributionAmount: {
                valueInCents: 2500,
              },
            },
          },
          fromUser,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const order = result.data.createOrder.order;
        expect(order.amount.valueInCents).to.eq(5000);
        expect(order.platformContributionAmount.valueInCents).to.eq(2500);
      });

      it('can add taxes', async () => {
        // TODO
      });

      it('respects the isSavedForLater param', async () => {
        const orderData = {
          ...validOrderParams,
          paymentMethod: { ...validOrderParams.paymentMethod, isSavedForLater: true },
        };

        // If saved
        const result = await callCreateOrder({ order: orderData }, fromUser);
        const order = result.data.createOrder.order;
        const orderFromDb = await models.Order.findByPk(order.legacyId);
        expect(orderFromDb.data.savePaymentMethod).to.be.true;

        // If not saved
        orderData.paymentMethod.isSavedForLater = false;
        const result2 = await callCreateOrder({ order: orderData }, fromUser);
        const order2 = result2.data.createOrder.order;
        const orderFromDb2 = await models.Order.findByPk(order2.legacyId);
        expect(orderFromDb2.data.savePaymentMethod).to.be.false;
      });

      it('works with a free ticket', async () => {
        const freeTicket = await fakeTier({
          CollectiveId: toCollective.id,
          type: 'TICKET',
          amount: 0,
          amountType: 'FIXED',
        });
        const fromUser = await fakeUser();
        const orderData = {
          tier: { legacyId: freeTicket.id },
          toAccount: { legacyId: toCollective.id },
          fromAccount: { legacyId: fromUser.CollectiveId },
          frequency: 'ONETIME',
          amount: { valueInCents: 0 },
        };

        const result = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order: orderData }, fromUser);
        expect(result.errors).to.not.exist;

        const order = result.data.createOrder.order;
        expect(order.status).to.eq('PAID');
        expect(order.amount.valueInCents).to.eq(0);
      });
    });

    describe('Guest', () => {
      it('Needs to provide an email', async () => {
        const result = await callCreateOrder({ order: { ...validOrderParams, fromAccount: null } });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.include(
          'You need to provide a guest profile with an email for logged out contributions',
        );
      });

      it('Works with a small order', async () => {
        const email = randEmail();
        const orderData = {
          ...validOrderParams,
          fromAccount: null,
          guestInfo: {
            email,
            legalName: 'Real name',
            captcha: { token: '10000000-aaaa-bbbb-cccc-000000000001', provider: 'HCAPTCHA' },
          },
        };
        const result = await callCreateOrder({ order: orderData });
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        const order = result.data.createOrder.order;
        expect(order.fromAccount.isGuest).to.eq(true);
        expect(order.fromAccount.legalName).to.eq(null); // For security reasons
        expect(order.paymentMethod.account.id).to.eq(order.fromAccount.id);
        expect(order.status).to.eq('PAID');

        const fromCollective = await models.Collective.findByPk(order.fromAccount.legacyId);
        expect(fromCollective.legalName).to.eq('Real name');
      });

      it('Works with an email that already exists (unverified)', async () => {
        const user = await fakeUser({ confirmedAt: null }, { data: { isGuest: true } });
        const orderData = {
          ...validOrderParams,
          fromAccount: null,
          guestInfo: {
            email: user.email,
            captcha: { token: '10000000-aaaa-bbbb-cccc-000000000001', provider: 'HCAPTCHA' },
          },
        };
        const result = await callCreateOrder({ order: orderData });
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        const order = result.data.createOrder.order;
        expect(order.fromAccount.legacyId).to.eq(user.CollectiveId);
        expect(order.fromAccount.isGuest).to.eq(true);
        expect(order.paymentMethod.account.id).to.eq(order.fromAccount.id);
        expect(order.status).to.eq('PAID');

        // Can make a second order
        const result2 = await callCreateOrder({ order: orderData });
        const order2 = result2.data.createOrder.order;
        expect(order2.fromAccount.legacyId).to.eq(user.CollectiveId);
        expect(order2.fromAccount.isGuest).to.eq(true);
        expect(order2.paymentMethod.account.id).to.eq(order2.fromAccount.id);
        expect(order2.status).to.eq('PAID');
      });

      it('Works with an email that already exists (verified)', async () => {
        const user = await fakeUser({ confirmedAt: new Date() });
        const orderData = {
          ...validOrderParams,
          fromAccount: null,
          guestInfo: {
            email: user.email,
            captcha: { token: '10000000-aaaa-bbbb-cccc-000000000001', provider: 'HCAPTCHA' },
          },
        };
        const result = await callCreateOrder({ order: orderData });
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        const order = result.data.createOrder.order;
        expect(order.fromAccount.legacyId).to.eq(user.CollectiveId);
        expect(order.fromAccount.isGuest).to.eq(false);
        expect(order.paymentMethod.account.id).to.eq(order.fromAccount.id);
        expect(order.status).to.eq('PAID');
      });

      it('If the account already exists, cannot use an existing payment method', async () => {
        const user = await fakeUser({ confirmedAt: new Date() });
        const paymentMethodData = { CollectiveId: user.CollectiveId, service: 'opencollective', type: 'prepaid' };
        const paymentMethod = await fakePaymentMethod(paymentMethodData);
        const orderData = {
          ...validOrderParams,
          paymentMethod: { id: idEncode(paymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
          fromAccount: null,
          guestInfo: {
            email: user.email,
            captcha: { token: '10000000-aaaa-bbbb-cccc-000000000001', provider: 'HCAPTCHA' },
          },
        };
        const result = await callCreateOrder({ order: orderData });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          'You need to be logged in to be able to use an existing payment method',
        );
      });

      it('Cannot contribute from a different profile as guest', async () => {
        const user = await fakeUser({ confirmedAt: new Date() });
        const fromCollective = await fakeCollective({ admin: user.collective });
        const orderData = {
          ...validOrderParams,
          fromAccount: { legacyId: fromCollective.id },
          guestInfo: {
            email: user.email,
            captcha: { token: '10000000-aaaa-bbbb-cccc-000000000001', provider: 'HCAPTCHA' },
          },
        };
        const result = await callCreateOrder({ order: orderData });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('You need to be logged in to specify a contributing profile');
      });

      it('Does not save the payment method', async () => {
        const orderData = {
          ...validOrderParams,
          fromAccount: null,
          paymentMethod: { ...validOrderParams.paymentMethod, isSavedForLater: true },
          guestInfo: {
            email: randEmail(),
            captcha: { token: '10000000-aaaa-bbbb-cccc-000000000001', provider: 'HCAPTCHA' },
          },
        };

        const result = await callCreateOrder({ order: orderData });
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const order = result.data.createOrder.order;
        const orderFromDb = await models.Order.findByPk(order.legacyId);
        expect(orderFromDb.data.savePaymentMethod).to.be.false;
      });

      it('Fails if captcha is not provided', async () => {
        const orderData = {
          ...validOrderParams,
          fromAccount: null,
          guestInfo: {
            email: randEmail(),
          },
        };
        const result = await callCreateOrder({ order: orderData });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('You need to inform a valid captcha token');
      });
    });
  });

  describe('Other mutations', () => {
    // This file and `OrderMutations.test.js` were implemented at the same time. We are merging the files,
    // but these tests would need to be reconciliated before we can put them in the same
    // `describe` than `createOrder`

    let adminUser,
      user,
      randomUser,
      collective,
      order,
      order2,
      paymentMethod,
      paymentMethod2,
      fixedTier,
      flexibleTier,
      host,
      hostAdminUser;

    before(async () => {
      await resetTestDB();
      await fakeHost({ id: 8686, slug: 'opencollective' });
      adminUser = await fakeUser();
      user = await fakeUser();
      randomUser = await fakeUser();
      hostAdminUser = await fakeUser();
      collective = await fakeCollective();
      host = collective.host;
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          status: 'ACTIVE',
        },
        {
          withSubscription: true,
        },
      );
      order2 = await fakeOrder(
        {
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          status: 'ACTIVE',
        },
        {
          withSubscription: true,
        },
      );
      paymentMethod = await fakePaymentMethod({
        service: 'stripe',
        type: 'creditcard',
        data: {
          expMonth: 11,
          expYear: 2025,
        },
        CollectiveId: user.CollectiveId,
        token: 'tok_5B5j8xDjPFcHOcTm3ogdnq0K',
      });
      paymentMethod2 = await fakePaymentMethod({
        service: 'stripe',
        type: 'creditcard',
        data: {
          expMonth: 11,
          expYear: 2025,
        },
        CollectiveId: randomUser.CollectiveId,
        token: 'tok_5B5j8xDjPFcHOcTm3ogdnq0K',
      });
      fixedTier = await fakeTier({
        CollectiveId: collective.id,
        amount: 7300,
        amountType: 'FIXED',
      });
      flexibleTier = await fakeTier({
        CollectiveId: collective.id,
        minimumAmount: 500,
        amount: 500,
        presets: [500, 750, 1000],
        amountType: 'FLEXIBLE',
      });
      await collective.addUserWithRole(adminUser, roles.ADMIN);
      await host.addUserWithRole(hostAdminUser, roles.ADMIN);
    });

    describe('cancelOrder', () => {
      it('must be authenticated', async () => {
        const result = await graphqlQueryV2(cancelRecurringContributionMutation, {
          order: { id: idEncode(order.id, 'order') },
        });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/You need to be logged in to cancel a recurring contribution/);
      });

      it('must be user who created the order', async () => {
        const result = await graphqlQueryV2(
          cancelRecurringContributionMutation,
          {
            order: { id: idEncode(order.id, 'order') },
          },
          randomUser,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/You don't have permission to cancel this recurring contribution/);
      });

      it('cancels the order', async () => {
        const result = await graphqlQueryV2(
          cancelRecurringContributionMutation,
          {
            order: { id: idEncode(order.id, 'order') },
          },
          user,
        );

        expect(result.errors).to.not.exist;
        expect(result.data.cancelOrder.status).to.eq('CANCELLED');
      });

      it('cannot cancel an already cancelled order', async () => {
        const result = await graphqlQueryV2(
          cancelRecurringContributionMutation,
          {
            order: { id: idEncode(order.id, 'order') },
          },
          user,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Recurring contribution already canceled/);
      });
    });

    describe('updateOrder', () => {
      it('must be authenticated', async () => {
        const result = await graphqlQueryV2(updateOrderMutation, {
          order: { id: idEncode(order2.id, 'order') },
        });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/You need to be logged in to update a order/);
      });

      it('must be user who created the order', async () => {
        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(order2.id, 'order') },
            amount: {
              value: 1000 / 100, // $10.00
            },
            tier: null, // null or named tier
          },
          randomUser,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/You don't have permission to update this order/);
      });

      it('cannot update an already cancelled order', async () => {
        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(order.id, 'order') },
          },
          user,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Order must be active to be updated/);
      });

      it('cannot update an order with a payment method they do not own', async () => {
        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(order2.id, 'order') },
            paymentMethod: {
              id: idEncode(paymentMethod2.id, 'paymentMethod'),
            },
          },
          user,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/You don't have permission to use this payment method/);
      });

      it('cannot update an order with an amount that does not match the fixed tier', async () => {
        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(order2.id, 'order') },
            amount: { value: 1000 / 100 },
            tier: { legacyId: fixedTier.id }, // null or named tier
          },
          user,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Amount is incorrect for this Tier./);
      });

      it('cannot update an order with an amount less than the tier minimum', async () => {
        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(order2.id, 'order') },
            amount: {
              value: 200 / 100, // $2.00
            },
            tier: { legacyId: flexibleTier.id },
          },
          user,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Amount is less than minimum value allowed for this Tier./);
      });

      it('updates the order payment method', async () => {
        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(order2.id, 'order') },
            paymentMethod: {
              id: idEncode(paymentMethod.id, 'paymentMethod'),
            },
          },
          user,
        );
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.updateOrder.paymentMethod.id).to.eq(idEncode(paymentMethod.id, 'paymentMethod'));
      });

      it('updates the order tier and amount', async () => {
        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(order2.id, 'order') },
            amount: {
              value: 7300 / 100,
            },
            tier: { legacyId: fixedTier.id },
          },
          user,
        );

        expect(result.errors).to.not.exist;
        expect(result.data.updateOrder.amount.value).to.eq(73);
        expect(result.data.updateOrder.tier.name).to.eq(fixedTier.name);
      });
    });

    describe('processPendingOrder', () => {
      beforeEach(async () => {
        order = await fakeOrder({
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          status: 'PENDING',
          frequency: 'ONETIME',
          totalAmount: 10000,
          currency: 'USD',
        });
      });

      it('should mark as expired', async () => {
        const result = await graphqlQueryV2(
          processPendingOrderMutation,
          {
            order: {
              id: idEncode(order.id, 'order'),
            },
            action: 'MARK_AS_EXPIRED',
          },
          hostAdminUser,
        );

        result.errors && console.log(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data).to.have.nested.property('processPendingOrder.status').equal('EXPIRED');
      });

      it('should mark as paid', async () => {
        const result = await graphqlQueryV2(
          processPendingOrderMutation,
          {
            order: {
              id: idEncode(order.id, 'order'),
            },
            action: 'MARK_AS_PAID',
          },
          hostAdminUser,
        );

        expect(result.errors).to.not.exist;
        expect(result.data).to.have.nested.property('processPendingOrder.status').equal('PAID');
      });

      it('should mark as paid and update amount details', async () => {
        const result = await graphqlQueryV2(
          processPendingOrderMutation,
          {
            action: 'MARK_AS_PAID',
            order: {
              id: idEncode(order.id, 'order'),
              amount: { valueInCents: 10100, currency: 'USD' },
              paymentProcessorFeesAmount: { valueInCents: 50, currency: 'USD' },
              platformTipAmount: { valueInCents: 100, currency: 'USD' },
            },
          },
          hostAdminUser,
        );

        expect(result.errors).to.not.exist;
        expect(result.data).to.have.nested.property('processPendingOrder.status').equal('PAID');

        const transactions = await order.getTransactions({ where: { type: 'CREDIT' } });
        const contribution = transactions.find(t => t.kind === 'CONTRIBUTION');
        expect(contribution).to.have.property('amount').equal(10050);
        expect(contribution).to.have.property('netAmountInCollectiveCurrency').equal(10000);
        expect(contribution).to.have.property('paymentProcessorFeeInHostCurrency').equal(-50);
        expect(contribution).to.have.nested.property('data.platformTip').equal(100);

        const tip = transactions.find(t => t.kind === 'PLATFORM_TIP');
        expect(tip).to.have.property('amount').equal(100);
      });
    });
  });
});
