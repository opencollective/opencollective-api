import { expect } from 'chai';
import config from 'config';
import gqlV2 from 'fake-tag';
import moment from 'moment';
import { createSandbox, useFakeTimers } from 'sinon';

import { roles } from '../../../../../server/constants';
import OrderStatuses from '../../../../../server/constants/order_status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import * as payments from '../../../../../server/lib/payments';
import stripe from '../../../../../server/lib/stripe';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import models from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import {
  fakeCollective,
  fakeHost,
  fakeOrder,
  fakeOrganization,
  fakePaymentMethod,
  fakeTier,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { generateValid2FAHeader, graphqlQueryV2, resetTestDB } from '../../../../utils';

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
        platformTipAmount {
          valueInCents
        }
        platformTipEligible
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

const PENDING_ORDER_FIELDS_FRAGMENT = gqlV2/* GraphQL */ `
  fragment PendingOrderFields on Order {
    id
    legacyId
    status
    quantity
    description
    frequency
    tags
    memo
    customData
    hostFeePercent
    pendingContributionData {
      expectedAt
      paymentMethod
      ponumber
      memo
      fromAccountInfo {
        name
        email
      }
    }
    tier {
      legacyId
    }
    taxes {
      type
      percentage
    }
    amount {
      valueInCents
      currency
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
    tier {
      legacyId
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
`;

const CREATE_PENDING_ORDER_MUTATION = gqlV2/* GraphQL */ `
  mutation CreatePendingOrder($order: PendingOrderCreateInput!) {
    createPendingOrder(order: $order) {
      ...PendingOrderFields
    }
  }
  ${PENDING_ORDER_FIELDS_FRAGMENT}
`;

const EDIT_PENDING_ORDER_MUTATION = gqlV2/* GraphQL */ `
  mutation EditPendingOrder($order: PendingOrderEditInput!) {
    editPendingOrder(order: $order) {
      ...PendingOrderFields
    }
  }
  ${PENDING_ORDER_FIELDS_FRAGMENT}
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

const moveOrdersMutation = gqlV2/* GraphQL */ `
  mutation MoveOrders(
    $orders: [OrderReferenceInput!]!
    $fromAccount: AccountReferenceInput
    $makeIncognito: Boolean
    $tier: TierReferenceInput
  ) {
    moveOrders(orders: $orders, fromAccount: $fromAccount, makeIncognito: $makeIncognito, tier: $tier) {
      id
      legacyId
      description
      createdAt
      amount {
        valueInCents
        currency
      }
      fromAccount {
        id
        legacyId
        name
        slug
        isIncognito
        imageUrl(height: 48)
      }
      toAccount {
        id
        legacyId
        slug
        name
      }
      tier {
        id
        legacyId
      }
      transactions {
        id
        type
        account {
          id
          legacyId
          name
        }
        oppositeAccount {
          id
          legacyId
          name
        }
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

const callCreatePendingOrder = (params, remoteUser = null) => {
  return graphqlQueryV2(CREATE_PENDING_ORDER_MUTATION, params, remoteUser);
};

const callEditPendingOrder = (params, remoteUser = null) => {
  return graphqlQueryV2(EDIT_PENDING_ORDER_MUTATION, params, remoteUser);
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
      sandbox.stub(stripe.tokens, 'retrieve').callsFake(() =>
        Promise.resolve({
          id: 'tok_123456781234567812345678',
          card: {
            brand: 'VISA',
            country: 'US',
            expMonth: 11,
            expYear: 2024,
          },
        }),
      );
      sandbox.stub(payments, 'executeOrder').callsFake(stubExecuteOrderFn);

      // Add Stripe to host
      host = await fakeHost({ plan: 'start-plan-2021' });
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
              platformTipAmount: {
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
        expect(order.platformTipAmount.valueInCents).to.eq(2500);
        expect(order.platformTipEligible).to.eq(true);
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
        const paymentMethodData = {
          CollectiveId: user.CollectiveId,
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.PREPAID,
        };
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
        const captchaDefaultValue = config.captcha.enabled;
        config.captcha.enabled = true;

        const orderData = {
          ...validOrderParams,
          fromAccount: null,
          guestInfo: {
            email: randEmail(),
          },
        };
        const result = await callCreateOrder({ order: orderData });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('You need to provide a valid captcha token');

        config.captcha.enabled = captchaDefaultValue;
      });
    });

    describe('Common checks', () => {
      it('collective must be approved by fiscal host', async () => {
        const host = await fakeHost();
        const collective = await fakeCollective({ HostCollectiveId: host.id, isActive: false, approvedAt: null });
        const fromUser = await fakeUser();
        const orderData = { ...validOrderParams, toAccount: { legacyId: collective.id } };

        const result = await callCreateOrder({ order: orderData }, fromUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          'This collective has no host and cannot accept financial contributions at this time.',
        );
      });
    });
  });

  describe('createPendingOrder', () => {
    let validOrderPrams, hostAdmin, collectiveAdmin;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      const host = await fakeHost({ admin: hostAdmin });
      const collective = await fakeCollective({ currency: 'USD', HostCollectiveId: host.id, admin: collectiveAdmin });
      const user = await fakeUser();
      validOrderPrams = {
        fromAccount: { legacyId: user.CollectiveId },
        toAccount: { legacyId: collective.id },
        amount: { valueInCents: 100e2, currency: 'USD' },
      };
    });

    it('must be authenticated', async () => {
      const result = await callCreatePendingOrder({ order: validOrderPrams });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can create pending orders');
    });

    it('must be host admin', async () => {
      const randomUser = await fakeUser();
      let result = await callCreatePendingOrder({ order: validOrderPrams }, randomUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can create pending orders');

      result = await callCreatePendingOrder({ order: validOrderPrams }, collectiveAdmin);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can create pending orders');
    });

    it('creates a pending order', async () => {
      const result = await callCreatePendingOrder({ order: validOrderPrams }, hostAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultOrder = result.data.createPendingOrder;
      expect(resultOrder.status).to.equal('PENDING');
      expect(resultOrder.amount.valueInCents).to.equal(100e2);
      expect(resultOrder.amount.currency).to.equal('USD');
      expect(resultOrder.frequency).to.equal('ONETIME');
      expect(resultOrder.fromAccount.legacyId).to.equal(validOrderPrams.fromAccount.legacyId);
      expect(resultOrder.toAccount.legacyId).to.equal(validOrderPrams.toAccount.legacyId);
    });

    it('creates a pending order with a custom tier', async () => {
      const tier = await fakeTier({
        CollectiveId: validOrderPrams.toAccount.legacyId,
        currency: validOrderPrams.toAccount.currency,
      });
      const orderInput = { ...validOrderPrams, tier: { legacyId: tier.id } };
      const result = await callCreatePendingOrder({ order: orderInput }, hostAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultOrder = result.data.createPendingOrder;
      expect(resultOrder.status).to.equal('PENDING');
      expect(resultOrder.tier.legacyId).to.equal(tier.id);
    });

    it('creates a pending order with tax', async () => {
      const orderInput = { ...validOrderPrams, tax: { type: 'VAT', rate: 0.21 } };
      const result = await callCreatePendingOrder({ order: orderInput }, hostAdmin);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultOrder = result.data.createPendingOrder;
      expect(resultOrder.status).to.equal('PENDING');
      expect(resultOrder.taxes).to.exist;
      expect(resultOrder.taxes.length).to.equal(1);
      expect(resultOrder.taxes[0].type).to.equal('VAT');
      expect(resultOrder.taxes[0].percentage).to.equal(21);
    });
  });

  describe('editPendingOrder', () => {
    let order, hostAdmin, collectiveAdmin;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      const host = await fakeHost({ admin: hostAdmin });
      const collective = await fakeCollective({ currency: 'USD', HostCollectiveId: host.id, admin: collectiveAdmin });
      const user = await fakeUser();
      order = await fakeOrder({
        status: OrderStatuses.PENDING,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        totalAmount: 1000,
        currency: 'USD',
      });
    });

    it('must be authenticated', async () => {
      const result = await callEditPendingOrder({
        order: {
          legacyId: order.id,
          amount: { valueInCents: 150e2, currency: 'USD' },
        },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can edit pending orders');
    });

    it('must be host admin', async () => {
      // Random user
      const randomUser = await fakeUser();
      let result = await callEditPendingOrder(
        {
          order: {
            legacyId: order.id,
            amount: { valueInCents: 150e2, currency: 'USD' },
          },
        },
        randomUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can edit pending orders');

      // Collective admin
      result = await callEditPendingOrder(
        {
          order: {
            legacyId: order.id,
            amount: { valueInCents: 150e2, currency: 'USD' },
          },
        },
        collectiveAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only host admins can edit pending orders');
    });

    it('must be a PENDING order', async () => {
      const paidOrder = await fakeOrder({ status: OrderStatuses.PAID });
      const hostAdmin = await fakeUser();
      await paidOrder.collective.host.addUserWithRole(hostAdmin, 'ADMIN');
      const result = await callEditPendingOrder(
        {
          order: {
            legacyId: paidOrder.id,
            amount: { valueInCents: 150e2, currency: 'USD' },
          },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Only pending orders can be edited, this one is PAID');
    });

    it('edits a pending order', async () => {
      const tier = await fakeTier({ CollectiveId: order.CollectiveId, currency: 'USD' });
      const newFromUser = await fakeUser();
      const result = await callEditPendingOrder(
        {
          order: {
            legacyId: order.id,
            tier: { legacyId: tier.id },
            fromAccount: { legacyId: newFromUser.CollectiveId },
            fromAccountInfo: { name: 'Hey', email: 'hey@opencollective.com' },
            description: 'New description',
            memo: 'New memo',
            ponumber: 'New ponumber',
            paymentMethod: 'New PM',
            expectedAt: '2023-01-01T00:00:00.000Z',
            amount: { valueInCents: 150e2, currency: 'USD' },
            hostFeePercent: 12.5,
            tax: {
              type: 'VAT',
              rate: 0.21,
              idNumber: '123456789',
              country: 'FR',
              amount: { valueInCents: 3150, currency: 'USD' },
            },
          },
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultOrder = result.data.editPendingOrder;
      expect(resultOrder.status).to.equal('PENDING');
      expect(resultOrder.amount.valueInCents).to.equal(18150); // $150 + $31.50 (21%) tax
      expect(resultOrder.amount.currency).to.equal('USD');
      expect(resultOrder.fromAccount.legacyId).to.equal(newFromUser.CollectiveId);
      expect(resultOrder.tier.legacyId).to.equal(tier.id);
      expect(resultOrder.description).to.equal('New description');
      expect(resultOrder.memo).to.equal('New memo');
      expect(resultOrder.pendingContributionData).to.exist;
      expect(resultOrder.pendingContributionData.ponumber).to.equal('New ponumber');
      expect(resultOrder.pendingContributionData.paymentMethod).to.equal('New PM');
      expect(resultOrder.pendingContributionData.expectedAt.toISOString()).to.equal('2023-01-01T00:00:00.000Z');
      expect(resultOrder.pendingContributionData.memo).to.equal('New memo');
      expect(resultOrder.pendingContributionData.fromAccountInfo).to.deep.equal({
        name: 'Hey',
        email: 'hey@opencollective.com',
      });

      expect(resultOrder.hostFeePercent).to.equal(12.5);
      expect(resultOrder.taxes).to.exist;
      expect(resultOrder.taxes.length).to.equal(1);
      expect(resultOrder.taxes[0].type).to.equal('VAT');
    });
  });

  describe('moveOrders', () => {
    const callMoveOrders = async (orders, loggedInUser, { fromAccount = null, makeIncognito = false, tier = null }) => {
      return graphqlQueryV2(
        moveOrdersMutation,
        {
          fromAccount: fromAccount ? { legacyId: fromAccount.id } : null,
          tier: !tier ? null : tier === 'custom' ? { isCustom: true } : { legacyId: tier.id },
          orders: orders.map(order => ({ id: idEncode(order.id, 'order') })),
          makeIncognito,
        },
        loggedInUser,
        undefined,
        loggedInUser && { [TwoFactorAuthenticationHeader]: generateValid2FAHeader(loggedInUser) },
      );
    };

    let rootUser;

    beforeEach(async () => {
      await resetTestDB();
      const rootOrg = await fakeOrganization({ id: 8686, slug: 'opencollective' });
      rootUser = await fakeUser({ data: { isRoot: true } }, { name: 'Root user' }, { enable2FA: true });
      await rootOrg.addUserWithRole(rootUser, 'ADMIN');
    });

    it('needs to be authenticated as root', async () => {
      const order = await fakeOrder({}, { withTransactions: true });
      const collectiveAdminUser = await fakeUser();
      const hostAdminUser = await fakeUser();
      await order.collective.addUserWithRole(collectiveAdminUser, 'ADMIN');
      await order.collective.host.addUserWithRole(hostAdminUser, 'ADMIN');

      for (const unauthorizedUser of [null, collectiveAdminUser, hostAdminUser]) {
        const result = await callMoveOrders([order], unauthorizedUser, { fromAccount: order.fromCollective });
        expect(result.errors).to.exist;
        expect(result.errors[0]).to.exist;
        if (unauthorizedUser) {
          expect(result.errors[0].extensions.code).to.equal('Forbidden');
        } else {
          expect(result.errors[0].extensions.code).to.equal('Unauthorized');
        }
      }
    });

    describe('prevents moving order if payment methods can be moved because...', () => {
      it('if another order with the same payment method depends on it', async () => {
        const paymentMethod = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
        });
        const fakeOrderOptions = { withTransactions: true, withBackerMember: true };
        const order1 = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);
        const order2 = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);
        const newProfile = (await fakeUser({}, { name: 'New profile' })).collective;

        // Move order
        const result = await callMoveOrders([order1], rootUser, { fromAccount: newProfile });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          `Can't move selected orders because the payment methods (#${paymentMethod.id}) are still used by other orders (#${order2.id})`,
        );
      });

      it('if the payment method is not supported (account balance)', async () => {
        const paymentMethod = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
          type: PAYMENT_METHOD_TYPE.COLLECTIVE,
        });
        const fakeOrderOptions = { withTransactions: true, withBackerMember: true };
        const order = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);
        const newProfile = (await fakeUser({}, { name: 'New profile' })).collective;

        // Move order
        const result = await callMoveOrders([order], rootUser, { fromAccount: newProfile });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          `Order #${order.id} has an unsupported payment method (opencollective/collective)`,
        );
      });
    });

    it('moves all data to another profile and summarize the changes in MigrationLogs', async () => {
      // Init data
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const fakeOrderOptions = { withTransactions: true, withBackerMember: true };
      const order = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);
      const newProfile = (await fakeUser({}, { name: 'New profile' })).collective;
      const backerMember = await models.Member.findOne({
        where: {
          MemberCollectiveId: order.FromCollectiveId,
          CollectiveId: order.CollectiveId,
          role: 'BACKER',
        },
      });

      // Move order
      const result = await callMoveOrders([order], rootUser, { fromAccount: newProfile });
      const resultOrder = result.data.moveOrders[0];

      // Check migration logs
      const migrationLog = await models.MigrationLog.findOne({
        where: { type: 'MOVE_ORDERS', CreatedByUserId: rootUser.id },
      });

      expect(migrationLog).to.exist;
      expect(migrationLog.data['fromAccount']).to.eq(newProfile.id);
      expect(migrationLog.data['previousOrdersValues'][order.id]).to.deep.eq({
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        TierId: null,
      });

      // Check order
      expect(migrationLog.data['orders']).to.deep.eq([order.id]);
      expect(resultOrder.fromAccount.legacyId).to.eq(newProfile.id);
      expect(resultOrder.toAccount.legacyId).to.eq(order.CollectiveId); // Should stay the same

      // Check transactions
      const allOrderTransactions = await models.Transaction.findAll({ where: { OrderId: order.id } });
      expect(migrationLog.data['transactions']).to.deep.eq(allOrderTransactions.map(t => t.id));

      const creditTransaction = resultOrder.transactions.find(t => t.type === 'CREDIT');
      expect(creditTransaction.oppositeAccount.legacyId).to.eq(newProfile.id);
      expect(creditTransaction.account.legacyId).to.eq(order.CollectiveId);

      const debitTransaction = resultOrder.transactions.find(t => t.type === 'DEBIT');
      expect(debitTransaction.oppositeAccount.legacyId).to.eq(order.CollectiveId);
      expect(debitTransaction.account.legacyId).to.eq(newProfile.id);

      // Check payment methods
      await paymentMethod.reload();
      expect(migrationLog.data['paymentMethods']).to.deep.eq([paymentMethod.id]);
      expect(paymentMethod.CollectiveId).to.eq(newProfile.id);

      // Check member
      await backerMember.reload();
      expect(migrationLog.data['members']).to.deep.eq([backerMember.id]);
      expect(backerMember.MemberCollectiveId).to.eq(newProfile.id);
      expect(backerMember.CollectiveId).to.eq(order.CollectiveId);
    });

    it('moves all to the incognito profile data and summarize the changes in MigrationLogs', async () => {
      // Init data
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const fakeOrderOptions = { withTransactions: true, withBackerMember: true };
      const order = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);
      const backerMember = await models.Member.findOne({
        where: {
          MemberCollectiveId: order.FromCollectiveId,
          CollectiveId: order.CollectiveId,
          role: 'BACKER',
        },
      });

      // Move order
      const result = await callMoveOrders([order], rootUser, {
        fromAccount: order.fromCollective,
        makeIncognito: true,
      });
      const resultOrder = result.data.moveOrders[0];

      // Incognito profile should have been created automatically
      const incognitoProfile = await order.fromCollective.getIncognitoProfile();

      // Check migration logs
      const migrationLog = await models.MigrationLog.findOne({
        where: { type: 'MOVE_ORDERS', CreatedByUserId: rootUser.id },
      });

      expect(migrationLog).to.exist;
      expect(migrationLog.data['fromAccount']).to.eq(incognitoProfile.id);
      expect(migrationLog.data['previousOrdersValues'][order.id]).to.deep.eq({
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        TierId: null,
      });

      // Check order
      expect(migrationLog.data['orders']).to.deep.eq([order.id]);
      expect(resultOrder.fromAccount.legacyId).to.eq(incognitoProfile.id);
      expect(resultOrder.toAccount.legacyId).to.eq(order.CollectiveId); // Should stay the same

      // Check transactions
      const allOrderTransactions = await models.Transaction.findAll({ where: { OrderId: order.id } });
      expect(migrationLog.data['transactions']).to.deep.eq(allOrderTransactions.map(t => t.id));

      const creditTransaction = resultOrder.transactions.find(t => t.type === 'CREDIT');
      expect(creditTransaction.oppositeAccount.legacyId).to.eq(incognitoProfile.id);
      expect(creditTransaction.account.legacyId).to.eq(order.CollectiveId);

      const debitTransaction = resultOrder.transactions.find(t => t.type === 'DEBIT');
      expect(debitTransaction.oppositeAccount.legacyId).to.eq(order.CollectiveId);
      expect(debitTransaction.account.legacyId).to.eq(incognitoProfile.id);

      // Check payment methods
      await paymentMethod.reload();
      expect(migrationLog.data['paymentMethods']).to.deep.eq([paymentMethod.id]);
      expect(paymentMethod.CollectiveId).to.eq(incognitoProfile.id);

      // Check member
      await backerMember.reload();
      expect(migrationLog.data['members']).to.deep.eq([backerMember.id]);
      expect(backerMember.MemberCollectiveId).to.eq(incognitoProfile.id);
      expect(backerMember.CollectiveId).to.eq(order.CollectiveId);
    });

    it('moves the contribution to the custom tier', async () => {
      // Init data
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const fakeOrderOptions = { withTransactions: true, withBackerMember: true, withTier: true };
      const order = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);
      const backerMember = await models.Member.findOne({
        where: {
          MemberCollectiveId: order.FromCollectiveId,
          CollectiveId: order.CollectiveId,
          role: 'BACKER',
        },
      });

      // Move order
      const result = await callMoveOrders([order], rootUser, { tier: 'custom' });
      const resultOrder = result.data.moveOrders[0];

      // Check migration logs
      const migrationLog = await models.MigrationLog.findOne({
        where: { type: 'MOVE_ORDERS', CreatedByUserId: rootUser.id },
      });

      expect(migrationLog).to.exist;
      expect(migrationLog.data['previousOrdersValues'][order.id]).to.deep.eq({
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        TierId: order.TierId,
      });

      // Check order
      expect(migrationLog.data['orders']).to.deep.eq([order.id]);
      expect(resultOrder.toAccount.legacyId).to.eq(order.CollectiveId); // Should stay the same
      expect(resultOrder.tier).to.be.null;

      // Check transactions
      expect(migrationLog.data['transactions']).to.be.empty;

      // Check member
      await backerMember.reload();
      expect(migrationLog.data['members']).to.deep.eq([backerMember.id]);
      expect(backerMember.TierId).to.be.null;
      expect(backerMember.CollectiveId).to.eq(order.CollectiveId); // Should stay the same
    });

    it('moves both the fromAccount and the contribution to a different tier', async () => {
      // Init data
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      const fakeOrderOptions = { withTransactions: true, withBackerMember: true, withTier: true };
      const order = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);
      const newTier = await fakeTier({ CollectiveId: order.CollectiveId });
      const newProfile = (await fakeUser({}, { name: 'New profile' })).collective;
      const backerMember = await models.Member.findOne({
        where: {
          MemberCollectiveId: order.FromCollectiveId,
          CollectiveId: order.CollectiveId,
          role: 'BACKER',
        },
      });

      // Move order
      const result = await callMoveOrders([order], rootUser, { fromAccount: newProfile, tier: newTier });
      const resultOrder = result.data.moveOrders[0];

      // Check migration logs
      const migrationLog = await models.MigrationLog.findOne({
        where: { type: 'MOVE_ORDERS', CreatedByUserId: rootUser.id },
      });

      expect(migrationLog).to.exist;
      expect(migrationLog.data['fromAccount']).to.eq(newProfile.id);
      expect(migrationLog.data['previousOrdersValues'][order.id]).to.deep.eq({
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        TierId: order.TierId,
      });

      // Check order
      expect(migrationLog.data['orders']).to.deep.eq([order.id]);
      expect(resultOrder.fromAccount.legacyId).to.eq(newProfile.id);
      expect(resultOrder.toAccount.legacyId).to.eq(order.CollectiveId); // Should stay the same
      expect(resultOrder.tier.legacyId).to.eq(newTier.id);

      // Check transactions
      const allOrderTransactions = await models.Transaction.findAll({ where: { OrderId: order.id } });
      expect(migrationLog.data['transactions']).to.deep.eq(allOrderTransactions.map(t => t.id));

      const creditTransaction = resultOrder.transactions.find(t => t.type === 'CREDIT');
      expect(creditTransaction.oppositeAccount.legacyId).to.eq(newProfile.id);
      expect(creditTransaction.account.legacyId).to.eq(order.CollectiveId);

      const debitTransaction = resultOrder.transactions.find(t => t.type === 'DEBIT');
      expect(debitTransaction.oppositeAccount.legacyId).to.eq(order.CollectiveId);
      expect(debitTransaction.account.legacyId).to.eq(newProfile.id);

      // Check payment methods
      await paymentMethod.reload();
      expect(migrationLog.data['paymentMethods']).to.deep.eq([paymentMethod.id]);
      expect(paymentMethod.CollectiveId).to.eq(newProfile.id);

      // Check member
      await backerMember.reload();
      expect(migrationLog.data['members']).to.deep.eq([backerMember.id]);
      expect(backerMember.MemberCollectiveId).to.eq(newProfile.id);
      expect(backerMember.TierId).to.eq(newTier.id);
      expect(backerMember.CollectiveId).to.eq(order.CollectiveId); // Should stay the same
    });

    it('moves an Added Fund to a different User profile', async () => {
      // Init data
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.HOST,
      });
      const fakeOrderOptions = { withTransactions: true, withBackerMember: true };
      const order = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);
      const newProfile = (await fakeUser({}, { name: 'New profile' })).collective;
      const backerMember = await models.Member.findOne({
        where: {
          MemberCollectiveId: order.FromCollectiveId,
          CollectiveId: order.CollectiveId,
          role: 'BACKER',
        },
      });

      // Move order
      const result = await callMoveOrders([order], rootUser, { fromAccount: newProfile });
      const resultOrder = result.data.moveOrders[0];

      // Check migration logs
      const migrationLog = await models.MigrationLog.findOne({
        where: { type: 'MOVE_ORDERS', CreatedByUserId: rootUser.id },
      });

      expect(migrationLog).to.exist;
      expect(migrationLog.data['fromAccount']).to.eq(newProfile.id);
      expect(migrationLog.data['previousOrdersValues'][order.id]).to.deep.eq({
        CollectiveId: order.CollectiveId,
        FromCollectiveId: order.FromCollectiveId,
        TierId: order.TierId,
      });

      // Check order
      expect(migrationLog.data['orders']).to.deep.eq([order.id]);
      expect(resultOrder.fromAccount.legacyId).to.eq(newProfile.id);
      expect(resultOrder.toAccount.legacyId).to.eq(order.CollectiveId); // Should stay the same

      // Check transactions
      const allOrderTransactions = await models.Transaction.findAll({ where: { OrderId: order.id } });
      expect(migrationLog.data['transactions']).to.deep.eq(allOrderTransactions.map(t => t.id));

      const creditTransaction = resultOrder.transactions.find(t => t.type === 'CREDIT');
      expect(creditTransaction.oppositeAccount.legacyId).to.eq(newProfile.id);
      expect(creditTransaction.account.legacyId).to.eq(order.CollectiveId);

      const debitTransaction = resultOrder.transactions.find(t => t.type === 'DEBIT');
      expect(debitTransaction.oppositeAccount.legacyId).to.eq(order.CollectiveId);
      expect(debitTransaction.account.legacyId).to.eq(newProfile.id);

      // Check payment methods ids in transactions and order
      expect(order.PaymentMethodId).to.eq(paymentMethod.id);
      expect(allOrderTransactions.filter(t => t.type === 'CREDIT')[0].PaymentMethodId).to.eq(paymentMethod.id);
      expect(allOrderTransactions.filter(t => t.type === 'DEBIT')[0].PaymentMethodId).to.eq(paymentMethod.id);

      // Check member
      await backerMember.reload();
      expect(migrationLog.data['members']).to.deep.eq([backerMember.id]);
      expect(backerMember.MemberCollectiveId).to.eq(newProfile.id);
      expect(backerMember.CollectiveId).to.eq(order.CollectiveId); // Should stay the same
    });

    it('try to move an Added Fund to a different Collective profile under different host', async () => {
      // Init data
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE,
        type: PAYMENT_METHOD_TYPE.HOST,
      });
      const fakeOrderOptions = { withTransactions: true, withBackerMember: true };
      const order = await fakeOrder({ PaymentMethodId: paymentMethod.id }, fakeOrderOptions);

      const newProfile = await fakeCollective({ name: 'New profile' });

      // Try to move order
      const result = await callMoveOrders([order], rootUser, { fromAccount: newProfile });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        `Moving Added Funds when the current source Account has a different Fiscal Host than the new source Account is not supported.`,
      );
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
      fixedMonthlyTier,
      fixedYearlyTier,
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
          status: OrderStatuses.ACTIVE,
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
          status: OrderStatuses.ACTIVE,
        },
        {
          withSubscription: true,
        },
      );
      paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        data: {
          expMonth: 11,
          expYear: 2025,
        },
        CollectiveId: user.CollectiveId,
        token: 'tok_5B5j8xDjPFcHOcTm3ogdnq0K',
      });
      paymentMethod2 = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
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
      fixedMonthlyTier = await fakeTier({
        CollectiveId: collective.id,
        amount: 7700,
        amountType: 'FIXED',
        interval: 'month',
      });
      fixedYearlyTier = await fakeTier({
        CollectiveId: collective.id,
        amount: 8800,
        amountType: 'FIXED',
        interval: 'year',
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
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
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

        result.errors && console.error(result.errors);
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
        expect(result.errors[0].extensions.code).to.equal('Unauthorized');
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

      it('when changing the amount, the tax amount is updated too', async () => {
        const orderWithTaxes = await fakeOrder(
          {
            CreatedByUserId: user.id,
            FromCollectiveId: user.CollectiveId,
            CollectiveId: collective.id,
            status: OrderStatuses.ACTIVE,
            totalAmount: 1300,
            taxAmount: 200,
            platformTipAmount: 100,
            currency: 'USD',
            data: { tax: { id: 'VAT', percentage: 20 } },
          },
          {
            withSubscription: true,
          },
        );

        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(orderWithTaxes.id, 'order') },
            amount: { valueInCents: 2000, currency: 'USD' },
          },
          user,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        await orderWithTaxes.reload();
        expect(orderWithTaxes.totalAmount).to.eq(2100);
        expect(orderWithTaxes.platformTipAmount).to.eq(100);
        expect(orderWithTaxes.taxAmount).to.eq(333); // 20% VAT on $2000 (tip is not included in the tax calculation)
        expect(orderWithTaxes.totalAmount - orderWithTaxes.taxAmount - orderWithTaxes.platformTipAmount).to.eq(1667); // Gross amount
      });

      describe('update interval', async () => {
        let clock;

        afterEach(() => {
          if (clock) {
            clock.restore();
            clock = null;
          }
        });
        it('from monthly to yearly', async () => {
          const today = moment(new Date(2022, 0, 1)); // 1st of January 2022
          clock = useFakeTimers(today.toDate()); // Manually setting today's date
          const subscription = { nextChargeDate: moment(today) };
          const monthlyOrder = await fakeOrder(
            {
              interval: 'month',
              subscription,
              CreatedByUserId: user.id,
              FromCollectiveId: user.CollectiveId,
              CollectiveId: collective.id,
              status: OrderStatuses.ACTIVE,
            },
            { withSubscription: true },
          );

          const result = await graphqlQueryV2(
            updateOrderMutation,
            {
              order: { id: idEncode(monthlyOrder.id, 'order') },
              amount: {
                value: 8800 / 100,
              },
              tier: { legacyId: fixedYearlyTier.id },
            },
            user,
          );

          expect(result.errors).to.not.exist;
          expect(result.data.updateOrder.amount.value).to.eq(88);
          expect(result.data.updateOrder.tier.name).to.eq(fixedYearlyTier.name);

          const updatedOrder = await models.Order.findOne({
            where: { id: monthlyOrder.id },
            include: [{ model: models.Subscription, required: true }],
          });

          expect(updatedOrder.Subscription.nextChargeDate.toISOString()).to.equal('2023-01-01T00:00:00.000Z');
          expect(updatedOrder.Subscription.nextPeriodStart.toISOString()).to.equal('2023-01-01T00:00:00.000Z');
        });

        it('from yearly to monthly (before the 15th of the month)', async () => {
          const today = moment(new Date(2022, 0, 1)); // 1st of January 2022
          clock = useFakeTimers(today.toDate()); // Manually setting today's date
          const subscription = { nextChargeDate: moment(today) };
          const yearlyOrder = await fakeOrder(
            {
              interval: 'year',
              subscription,
              CreatedByUserId: user.id,
              FromCollectiveId: user.CollectiveId,
              CollectiveId: collective.id,
              status: OrderStatuses.ACTIVE,
            },
            { withSubscription: true },
          );

          const result = await graphqlQueryV2(
            updateOrderMutation,
            {
              order: { id: idEncode(yearlyOrder.id, 'order') },
              amount: {
                value: 7700 / 100,
              },
              tier: { legacyId: fixedMonthlyTier.id },
            },
            user,
          );

          expect(result.errors).to.not.exist;
          expect(result.data.updateOrder.amount.value).to.eq(77);
          expect(result.data.updateOrder.tier.name).to.eq(fixedMonthlyTier.name);

          const updatedOrder = await models.Order.findOne({
            where: { id: yearlyOrder.id },
            include: [{ model: models.Subscription, required: true }],
          });

          expect(updatedOrder.Subscription.nextChargeDate.toISOString()).to.equal('2022-02-01T00:00:00.000Z');
          expect(updatedOrder.Subscription.nextPeriodStart.toISOString()).to.equal('2022-02-01T00:00:00.000Z');
        });

        it('from yearly to monthly (after the 15th of the month)', async () => {
          const today = moment(new Date(2022, 0, 18)); // 18th of January 2022
          clock = useFakeTimers(today.toDate()); // Manually setting today's date
          const subscription = { nextChargeDate: moment(today) };
          const yearlyOrder = await fakeOrder(
            {
              interval: 'year',
              subscription,
              CreatedByUserId: user.id,
              FromCollectiveId: user.CollectiveId,
              CollectiveId: collective.id,
              status: OrderStatuses.ACTIVE,
            },
            { withSubscription: true },
          );

          const result = await graphqlQueryV2(
            updateOrderMutation,
            {
              order: { id: idEncode(yearlyOrder.id, 'order') },
              amount: {
                value: 7700 / 100,
              },
              tier: { legacyId: fixedMonthlyTier.id },
            },
            user,
          );

          expect(result.errors).to.not.exist;
          expect(result.data.updateOrder.amount.value).to.eq(77);
          expect(result.data.updateOrder.tier.name).to.eq(fixedMonthlyTier.name);

          const updatedOrder = await models.Order.findOne({
            where: { id: yearlyOrder.id },
            include: [{ model: models.Subscription, required: true }],
          });

          expect(updatedOrder.Subscription.nextChargeDate.toISOString()).to.equal('2022-03-01T00:00:00.000Z');
          expect(updatedOrder.Subscription.nextPeriodStart.toISOString()).to.equal('2022-03-01T00:00:00.000Z');
        });
      });
    });

    describe('processPendingOrder', () => {
      beforeEach(async () => {
        order = await fakeOrder({
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: collective.id,
          status: OrderStatuses.PENDING,
          frequency: 'ONETIME',
          totalAmount: 10000,
          currency: 'USD',
        } as any);
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
              amount: { valueInCents: 10000, currency: order.currency },
              paymentProcessorFee: { valueInCents: 50, currency: order.currency },
              platformTip: { valueInCents: 100, currency: order.currency },
            },
          },
          hostAdminUser,
        );

        result.errors && console.log(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data).to.have.nested.property('processPendingOrder.status').equal('PAID');

        await order.reload();
        expect(order).to.have.property('totalAmount').equal(10100);
        expect(order).to.have.property('platformTipAmount').equal(100);

        const transactions = await order.getTransactions({ where: { type: 'CREDIT' } });
        const contribution = transactions.find(t => t.kind === 'CONTRIBUTION');
        expect(contribution).to.have.property('amount').equal(10000);
        expect(contribution).to.have.property('netAmountInCollectiveCurrency').equal(9950);
        expect(contribution).to.have.property('paymentProcessorFeeInHostCurrency').equal(-50);

        const tip = transactions.find(t => t.kind === 'PLATFORM_TIP');
        expect(tip).to.have.property('amount').equal(100);
      });
    });

    it('should be able to remove platform tips', async () => {
      const orderWithPlatformTip = await fakeOrder({
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        status: OrderStatuses.PENDING,
        frequency: 'ONETIME',
        totalAmount: 10100,
        currency: 'USD',
        platformTipAmount: 100,
      } as any);

      const result = await graphqlQueryV2(
        processPendingOrderMutation,
        {
          action: 'MARK_AS_PAID',
          order: {
            id: idEncode(orderWithPlatformTip.id, 'order'),
            platformTip: { valueInCents: 0, currency: orderWithPlatformTip.currency },
            amount: { valueInCents: 10000, currency: orderWithPlatformTip.currency },
          },
        },
        hostAdminUser,
      );

      result.errors && console.log(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data).to.have.nested.property('processPendingOrder.status').equal('PAID');

      await orderWithPlatformTip.reload();
      expect(orderWithPlatformTip).to.have.property('totalAmount').equal(10000);
      expect(orderWithPlatformTip).to.have.property('platformTipAmount').equal(0);

      const transactions = await orderWithPlatformTip.getTransactions({ where: { type: 'CREDIT' } });
      const contribution = transactions.find(t => t.kind === 'CONTRIBUTION');
      expect(contribution).to.have.property('amount').equal(10000);
      expect(contribution).to.have.property('netAmountInCollectiveCurrency').equal(10000);

      const tip = transactions.find(t => t.kind === 'PLATFORM_TIP');
      expect(tip).to.be.undefined;
    });
  });
});
