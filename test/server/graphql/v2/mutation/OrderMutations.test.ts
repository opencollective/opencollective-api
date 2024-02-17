import { expect } from 'chai';
import config from 'config';
import gql from 'fake-tag';
import { cloneDeep, set } from 'lodash';
import moment from 'moment';
import { createSandbox, useFakeTimers } from 'sinon';

import { roles } from '../../../../../server/constants';
import OrderStatuses from '../../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../../server/constants/paymentMethods';
import MemberRoles from '../../../../../server/constants/roles';
import { TransactionTypes } from '../../../../../server/constants/transactions';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import * as OrderSecurityLib from '../../../../../server/lib/security/order';
import stripe from '../../../../../server/lib/stripe';
import twitterLib from '../../../../../server/lib/twitter';
import { TwoFactorAuthenticationHeader } from '../../../../../server/lib/two-factor-authentication/lib';
import models from '../../../../../server/models';
import * as StripeCommon from '../../../../../server/paymentProviders/stripe/common';
import { randEmail, stripeConnectedAccount } from '../../../../stores';
import {
  fakeAccountingCategory,
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeEvent,
  fakeHost,
  fakeOrder,
  fakeOrganization,
  fakePaymentMethod,
  fakeTier,
  fakeUser,
  randStr,
} from '../../../../test-helpers/fake-data';
import {
  generateValid2FAHeader,
  graphqlQueryV2,
  resetTestDB,
  stubStripeBalance,
  stubStripeCreate,
  waitForCondition,
} from '../../../../utils';

const CREATE_ORDER_MUTATION = gql`
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
          currency
        }
        taxAmount {
          valueInCents
          currency
        }
        tax {
          id
          type
          percentage
          rate
          idNumber
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
        transactions {
          type
          kind
          taxAmount {
            valueInCents
          }
        }
      }
    }
  }
`;

const PENDING_ORDER_FIELDS_FRAGMENT = gql`
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
    accountingCategory {
      id
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

const CREATE_PENDING_ORDER_MUTATION = gql`
  mutation CreatePendingOrder($order: PendingOrderCreateInput!) {
    createPendingOrder(order: $order) {
      ...PendingOrderFields
    }
  }
  ${PENDING_ORDER_FIELDS_FRAGMENT}
`;

const EDIT_PENDING_ORDER_MUTATION = gql`
  mutation EditPendingOrder($order: PendingOrderEditInput!) {
    editPendingOrder(order: $order) {
      ...PendingOrderFields
    }
  }
  ${PENDING_ORDER_FIELDS_FRAGMENT}
`;

const updateOrderMutation = gql`
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

const updateOrderAccountingCategoryMutation = gql`
  mutation UpdateOrderAccountingCategory(
    $order: OrderReferenceInput!
    $accountingCategory: AccountingCategoryReferenceInput
  ) {
    updateOrderAccountingCategory(order: $order, accountingCategory: $accountingCategory) {
      id
      accountingCategory {
        id
        code
        name
      }
    }
  }
`;

const moveOrdersMutation = gql`
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

const cancelRecurringContributionMutation = gql`
  mutation CancelRecurringContribution($order: OrderReferenceInput!) {
    cancelOrder(order: $order) {
      id
      status
    }
  }
`;

const processPendingOrderMutation = gql`
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

const callUpdateOrderAccountingCategory = (variables, remoteUser = null) => {
  return graphqlQueryV2(updateOrderAccountingCategoryMutation, variables, remoteUser);
};

const stubStripePayments = sandbox => {
  sandbox.stub(stripe.tokens, 'retrieve').callsFake(() =>
    Promise.resolve({
      card: {
        token: 'tok_testtoken123456789012345',
        brand: 'VISA',
        country: 'US',
        expMonth: 11,
        expYear: 2024,
        last4: '4242',
        name: 'John Smith',
      },
    }),
  );

  const stripePaymentMethodId = randStr('pm_');
  sandbox.stub(StripeCommon, 'resolvePaymentMethodForOrder').resolves({
    id: stripePaymentMethodId,
    customer: 'cus_test',
  });
  sandbox.stub(stripe.paymentIntents, 'create').resolves({ id: 'pi_test', status: 'requires_confirmation' });
  sandbox.stub(stripe.paymentIntents, 'confirm').resolves({
    id: stripePaymentMethodId,
    status: 'succeeded',
    charges: {
      // eslint-disable-next-line camelcase
      data: [{ id: 'ch_id', balance_transaction: 'txn_id' }],
    },
  });

  sandbox.stub(stripe.balanceTransactions, 'retrieve').resolves({
    amount: 1100,
    currency: 'usd',
    fee: 0,
    // eslint-disable-next-line camelcase
    fee_details: [],
  });
};

describe('server/graphql/v2/mutation/OrderMutations', () => {
  describe('createOrder', () => {
    describe('General cases', () => {
      let fromUser, toCollective, host, validOrderParams, sandbox, emailSendMessageSpy;

      before(async () => {
        await resetTestDB();
        fromUser = await fakeUser();

        // Stub the payment
        sandbox = createSandbox();
        stubStripePayments(sandbox);
        sandbox.stub(OrderSecurityLib, 'orderFraudProtection').callsFake(() => Promise.resolve());
        emailSendMessageSpy = sandbox.spy(emailLib, 'sendMessage');

        // Add Stripe to host
        host = await fakeHost({ plan: 'start-plan-2021' });
        toCollective = await fakeCollective({ HostCollectiveId: host.id });
        await models.ConnectedAccount.create({
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          token: 'abc',
          CollectiveId: host.id,
        });

        // Add OC Inc (for platform tips)
        await fakeOrganization({ id: 8686, slug: 'opencollective' });

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
              token: 'tok_testtoken123456789012345',
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
          const collectiveWithoutPlatformFee = await fakeCollective({
            platformFeePercent: 0,
            HostCollectiveId: host.id,
          });
          const result = await callCreateOrder(
            {
              order: {
                ...validOrderParams,
                toAccount: { legacyId: collectiveWithoutPlatformFee.id },
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

        it('creates an order for an event ticket and receives the ticket confirmation by email with iCal.ics attached', async () => {
          const d = new Date('2042-01-01');
          const startsAt = d.setMonth(d.getMonth() + 1);
          const endsAt = new Date(startsAt);
          endsAt.setHours(endsAt.getHours() + 2);
          const event = await fakeEvent({
            ParentCollectiveId: toCollective.id,
            name: 'Sustain OSS London 2019',
            description: 'Short description',
            longDescription: 'Longer description',
            slug: 'sustainoss-london',
            startsAt,
            endsAt,
            location: { name: 'Github', address: 'London' },
            timezone: 'Europe/Brussels',
          });
          const ticket = await fakeTier({
            CollectiveId: event.id,
            name: 'tier-name',
            type: 'TICKET',
            amount: 0,
            amountType: 'FLEXIBLE',
            presets: [0, 500, 1000],
          });

          emailSendMessageSpy.resetHistory();
          const res = await callCreateOrder(
            {
              order: {
                ...validOrderParams,
                tier: { legacyId: ticket.id },
                toAccount: { legacyId: event.id },
                frequency: 'ONETIME',
                amount: { valueInCents: 500 },
              },
            },
            fromUser,
          );

          // There should be no errors
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;

          const findTicketEmail = () => emailSendMessageSpy.args.find(args => args[1].includes('ticket confirmed'));
          const email = await waitForCondition(findTicketEmail);
          expect(email[0]).to.equal(fromUser.email);
          expect(email[1]).to.equal(`1 ticket confirmed for ${event.name}`);
          expect(email[3].attachments[0].filename).to.equal(`${event.slug}.ics`);
          expect(email[3].attachments[0].content).to.contain('SUMMARY:Sustain OSS London 2019');
          expect(email[3].attachments[0].content).to.contain('DTSTART:20420201T000000Z');
          expect(email[3].attachments[0].content).to.contain('DTEND:20420201T020000Z');
          expect(email[3].attachments[0].content).to.contain('LOCATION:Github\\, London');
          expect(email[3].attachments[0].content).to.contain('DESCRIPTION:Short description\\n\\nLonger description');
          expect(email[3].attachments[0].content).to.contain('ORGANIZER;CN="Test Collective');
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

        it('collective must exist', async () => {
          const fromUser = await fakeUser();
          const orderData = { ...validOrderParams, toAccount: { legacyId: 9999999 } };
          const result = await callCreateOrder({ order: orderData }, fromUser);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.equal('Account Not Found');
        });

        it('tier must exist', async () => {
          const fromUser = await fakeUser();
          const orderData = { ...validOrderParams, tier: { legacyId: 9999999 } };
          const result = await callCreateOrder({ order: orderData }, fromUser);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.equal('Tier Not Found');
        });

        it('enforces payment method when there is an amount', async () => {
          const fromUser = await fakeUser();
          const orderData = { ...validOrderParams, paymentMethod: null };
          const result = await callCreateOrder({ order: orderData }, fromUser);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.equal('This order requires a payment method');
        });

        it('sends a tweet', async () => {
          const newContributor = await fakeUser(null, { twitterHandle: 'johnsmith' }); // Only new contributors get a tweet
          const collective = await fakeCollective({ twitterHandle: 'test', HostCollectiveId: host.id });
          await fakeConnectedAccount({
            CollectiveId: collective.id,
            service: 'twitter',
            clientId: 'xxxx',
            token: 'xxxx',
            settings: {
              newBacker: { active: true, tweet: '{backerTwitterHandle} thank you for your {amount} donation!' },
            },
          });

          const tweetStatusStub = sandbox.stub(twitterLib, 'tweetStatus');
          const orderData = {
            ...validOrderParams,
            fromAccount: { legacyId: newContributor.CollectiveId },
            toAccount: { legacyId: collective.id },
          };
          const result = await callCreateOrder({ order: orderData }, newContributor);
          result.errors && console.error(result.errors);
          expect(result.errors).to.not.exist;
          await waitForCondition(() => tweetStatusStub.callCount > 0);
          expect(tweetStatusStub.firstCall.args[1]).to.contain('@johnsmith thank you for your $50.00 donation!');
        });
      });

      describe('Quantity', () => {
        it('fails if not enough available', async () => {
          const tier = await fakeTier({ maxQuantity: 10, CollectiveId: toCollective.id, name: 'My Tier' });
          const orderData = { ...validOrderParams, tier: { legacyId: tier.id }, quantity: 11 };
          const result = await callCreateOrder({ order: orderData }, fromUser);
          expect(result.errors).to.exist;
          expect(result.errors[0].message).to.equal('No more tickets left for My Tier');
        });
      });
    });

    describe('Taxes', () => {
      describe('VAT', () => {
        let tierProduct, hostWithVAT, validOrderParams, fromUser, sandbox;

        before(async () => {
          sandbox = createSandbox();
          stubStripePayments(sandbox);

          fromUser = await fakeUser();
          hostWithVAT = await fakeActiveHost({
            countryISO: 'FR', // France, 20% VAT
            settings: { VAT: { type: 'OWN', number: 'FRXX999999999' } },
            currency: 'EUR',
          });
          await models.ConnectedAccount.create({
            service: PAYMENT_METHOD_SERVICE.STRIPE,
            token: 'abc',
            CollectiveId: hostWithVAT.id,
          });

          tierProduct = await fakeTier({
            type: 'PRODUCT',
            amount: 5000,
            interval: null,
            currency: 'EUR',
            CollectiveId: hostWithVAT.id,
          });

          validOrderParams = {
            fromAccount: { legacyId: fromUser.CollectiveId },
            toAccount: { legacyId: hostWithVAT.id },
            tier: { legacyId: tierProduct.id },
            amount: {
              valueInCents: 5000,
              currency: 'EUR',
            },
            tax: {
              type: 'VAT',
              rate: 20,
              amount: { valueInCents: 1000, currency: 'EUR' },
              country: 'FR',
            },
            frequency: 'ONETIME',
            paymentMethod: {
              service: 'STRIPE',
              type: 'CREDITCARD',
              name: '4242',
              creditCardInfo: {
                token: 'tok_visa',
                brand: 'VISA',
                country: 'US',
                expMonth: 11,
                expYear: 2024,
              },
            },
          };
        });

        after(() => {
          sandbox.restore();
        });

        it('stores tax in order and transaction', async () => {
          const frenchVAT = 20;
          const taxAmount = Math.round(tierProduct.amount * (frenchVAT / 100));
          const res = await callCreateOrder({ order: validOrderParams }, fromUser);

          // There should be no errors
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;

          const createdOrder = res.data.createOrder.order;
          expect(createdOrder.taxAmount).to.exist;
          expect(createdOrder.taxAmount.valueInCents).to.equal(taxAmount);
          expect(createdOrder.tax).to.deep.equal({
            id: 'VAT',
            type: 'VAT',
            idNumber: null,
            percentage: 20,
            rate: 0.2,
          });

          const orderFromDB = await models.Order.findByPk(createdOrder.legacyId);
          expect(orderFromDB.data.tax).to.deep.equal({
            id: 'VAT',
            taxerCountry: 'FR',
            taxedCountry: 'FR',
            taxIDNumberFrom: 'FRXX999999999',
            percentage: 20,
          });

          expect(createdOrder.transactions).to.have.length(2);
          createdOrder.transactions
            .filter(t => t.kind === 'CONTRIBUTION')
            .map(transaction => {
              expect(transaction.taxAmount.valueInCents).to.equal(-taxAmount);
            });
        });

        it("doesn't have tax when tax id number is set for other EU countries", async () => {
          const order = cloneDeep(validOrderParams);
          set(order, 'tax.country', 'DE');
          set(order, 'tax.idNumber', 'DE256625648');
          set(order, 'tax.amount.valueInCents', 0);
          const res = await callCreateOrder({ order }, fromUser);

          // There should be no errors
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;

          const createdOrder = res.data.createOrder.order;
          expect(createdOrder.taxAmount).to.be.null;
          expect(createdOrder.transactions).to.have.length(2);
          createdOrder.transactions
            .filter(t => t.kind === 'CONTRIBUTION')
            .map(transaction => {
              expect(transaction.taxAmount.valueInCents).to.equal(0);
            });
        });

        it('have tax when tax id number is set with same EU country', async () => {
          const frenchVAT = 20;
          const taxAmount = Math.round(tierProduct.amount * (frenchVAT / 100));
          const order = cloneDeep(validOrderParams);
          set(order, 'tax.country', 'FR');
          set(order, 'tax.idNumber', 'FRXX999999997');
          const res = await callCreateOrder({ order }, fromUser);

          // There should be no errors
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;

          const createdOrder = res.data.createOrder.order;
          expect(createdOrder.taxAmount.valueInCents).to.equal(taxAmount);
          expect(createdOrder.transactions).to.have.length(2);
          createdOrder.transactions
            .filter(t => t.kind === 'CONTRIBUTION')
            .map(transaction => {
              expect(transaction.taxAmount.valueInCents).to.equal(-taxAmount);
            });
        });

        it('reject orders without country when subject to VAT', async () => {
          const order = cloneDeep(validOrderParams);
          set(order, 'tax.country', null);
          const queryResult = await callCreateOrder({ order }, fromUser);
          expect(queryResult.errors[0].message).to.equal('This order has a tax attached, you must set a country');
        });

        it('rejects invalid VAT ID numbers', async () => {
          const order = cloneDeep(validOrderParams);
          set(order, 'tax.idNumber', 'XXXXXXXXXXXXXXXXXXXXXXXXXXX');
          const res = await callCreateOrder({ order }, fromUser);
          expect(res.errors[0].message).to.equal('Invalid VAT number');
        });

        it('rejects 0 tax amount', async () => {
          const order = cloneDeep(validOrderParams);
          set(order, 'tax', null);
          const res = await callCreateOrder({ order }, fromUser);
          expect(res.errors[0].message).to.equal('This contribution should have a tax attached');
        });

        it('rejects invalid tax amount', async () => {
          const order = cloneDeep(validOrderParams);
          set(order, 'tax.amount.valueInCents', 999);
          const res = await callCreateOrder({ order }, fromUser);
          expect(res.errors[0].message).to.equal(
            'This tier uses a fixed amount. Order total must be €50.00 + €10.00 tax. You set: €59.99',
          );
        });

        it('defaults to VAT enabled if configured on the host', async () => {
          const collective = await fakeCollective({ HostCollectiveId: hostWithVAT.id, currency: 'EUR' });
          const tier = await fakeTier({
            type: 'PRODUCT',
            amount: 5000,
            interval: null,
            currency: 'EUR',
            CollectiveId: collective.id,
          });
          const frenchVAT = 20;
          const taxAmount = Math.round(tier.amount * (frenchVAT / 100));
          const order = cloneDeep(validOrderParams);
          set(order, 'toAccount.legacyId', collective.id);
          set(order, 'tier.legacyId', tier.id);
          const res = await callCreateOrder({ order }, fromUser);

          // There should be no errors
          res.errors && console.error(res.errors);
          expect(res.errors).to.not.exist;

          const createdOrder = res.data.createOrder.order;
          expect(createdOrder.taxAmount.valueInCents).to.equal(taxAmount);

          expect(createdOrder.tax).to.deep.equal({
            id: 'VAT',
            type: 'VAT',
            idNumber: null,
            percentage: 20,
            rate: 0.2,
          });

          const orderFromDB = await models.Order.findByPk(createdOrder.legacyId);
          expect(orderFromDB.data.tax).to.deep.equal({
            id: 'VAT',
            taxerCountry: 'FR',
            taxedCountry: 'FR',
            taxIDNumberFrom: 'FRXX999999999',
            percentage: 20,
          });
        });
      });
    });

    describe('payment methods', () => {
      let host, validOrderParams, fromUser, sandbox;

      before(async () => {
        sandbox = createSandbox();

        fromUser = await fakeUser();
        host = await fakeActiveHost({
          countryISO: 'FR', // France, 20% VAT
          settings: { VAT: { type: 'OWN', number: 'FRXX999999999' } },
          currency: 'EUR',
        });
        await fakeConnectedAccount({
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          CollectiveId: host.id,
          token: 'sk_test_123',
        });

        validOrderParams = {
          fromAccount: { legacyId: fromUser.CollectiveId },
          toAccount: { legacyId: host.id },
          amount: {
            valueInCents: 5000,
            currency: 'EUR',
          },
          frequency: 'ONETIME',
          paymentMethod: {
            service: 'STRIPE',
            type: 'CREDITCARD',
            name: '4242',
            creditCardInfo: {
              token: 'tok_visa',
              brand: 'VISA',
              country: 'US',
              expMonth: 11,
              expYear: 2024,
            },
          },
        };
      });

      beforeEach(() => {
        sandbox.stub(OrderSecurityLib, 'orderFraudProtection').callsFake(() => Promise.resolve());
        stubStripePayments(sandbox);
      });

      afterEach(() => {
        sandbox.restore();
      });

      it('fails to use a payment method on file if not logged in', async () => {
        const order = cloneDeep(validOrderParams);
        const paymentMethod = await fakePaymentMethod();
        order.paymentMethod = { id: idEncode(paymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) };
        order.fromAccount = null;

        const result = await callCreateOrder({ order: { ...order, guestInfo: { email: randEmail() } } });
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          'You need to be logged in to be able to use an existing payment method',
        );
      });

      it('fails to use a payment method on file if not logged in as the owner', async () => {
        const order = cloneDeep(validOrderParams);
        const paymentMethod = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
        });
        order.paymentMethod = { id: idEncode(paymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) };
        order.fromAccount = null;

        const result = await callCreateOrder({ order }, fromUser);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          "You don't have enough permissions to use this payment method (you need to be an admin of the collective that owns this payment method)",
        );
      });

      it("doesn't store the payment method for user if order fail", async () => {
        const newUser = await fakeUser();
        const order = cloneDeep({ ...validOrderParams, fromAccount: { legacyId: newUser.CollectiveId } });
        order.paymentMethod.isSavedForLater = false;
        stripe.paymentIntents.create = sandbox.stub().rejects(new Error('NOT TODAY!'));
        const result = await callCreateOrder({ order }, fromUser);
        expect(result.errors).to.exist;
        const paymentMethods = await models.PaymentMethod.findAll({ where: { CollectiveId: newUser.CollectiveId } });
        expect(paymentMethods).to.have.length(0);
      });

      it('user becomes a financial contributor of collective using a payment method on file', async () => {
        const collective = await fakeCollective({ HostCollectiveId: host.id, currency: host.currency });
        const paymentMethod = await fakePaymentMethod({
          CollectiveId: fromUser.CollectiveId,
          CreatedByUserId: fromUser.id,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          name: 'xxxx',
          archivedAt: null,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          saved: true,
          expiryDate: moment().add(1, 'year') as unknown as Date,
        });

        const order = cloneDeep(validOrderParams);
        order.paymentMethod = { id: idEncode(paymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) };
        order.toAccount = { legacyId: collective.id };

        const result = await callCreateOrder({ order }, fromUser);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        const members = await models.Member.findAll({
          where: { CollectiveId: collective.id, role: 'BACKER' },
        });
        const orders = await models.Order.findAll({
          where: { FromCollectiveId: fromUser.CollectiveId, CollectiveId: collective.id },
        });
        const transactions = await models.Transaction.findAll({
          where: { FromCollectiveId: fromUser.CollectiveId, CollectiveId: collective.id },
        });
        expect(members).to.have.length(1);
        expect(orders).to.have.length(1);
        expect(transactions).to.have.length(1);
        expect(transactions[0].amount).to.equal(order.amount.valueInCents);
      });

      it('user becomes a backer of collective using a new payment method', async () => {
        const result = await callCreateOrder({ order: validOrderParams }, fromUser);
        result.errors && console.error(result.errors[0]);
        expect(result.errors).to.not.exist;
        const members = await models.Member.findAll({
          where: { MemberCollectiveId: fromUser.CollectiveId, CollectiveId: host.id, role: 'BACKER' },
        });
        expect(members).to.have.length(1);
        const paymentMethods = await models.PaymentMethod.findAll({
          where: { CreatedByUserId: fromUser.id },
        });
        expect(paymentMethods).to.have.length(2);
      });
    });

    // Moved/adapted from `test/server/paymentProviders/opencollective/collective.test.js` + `test/server/graphql/v1/createOrder.test.js`
    describe('Collective to Collective Transactions', () => {
      const ORDER_TOTAL_AMOUNT = 1000;
      const STRIPE_FEE_STUBBED_VALUE = 300;
      let sandbox,
        user1,
        user2,
        transactions,
        collective1,
        collective2,
        collective3,
        collective5,
        host1,
        host2,
        host3,
        organization,
        stripePaymentMethod;

      before(async () => {
        user1 = await fakeUser({ name: 'User 1' });
        user2 = await fakeUser({ name: 'User 2' });
        host1 = await fakeActiveHost({ name: 'Host 1', currency: 'USD' });
        host2 = await fakeActiveHost({ name: 'Host 2', currency: 'USD' });
        host3 = await fakeActiveHost({ name: 'Host 3', currency: 'EUR' });
        collective1 = await fakeCollective({ name: 'collective1', HostCollectiveId: host1.id, currency: 'USD' });
        collective2 = await fakeCollective({ name: 'collective2', HostCollectiveId: host1.id, currency: 'USD' });
        collective3 = await fakeCollective({ name: 'collective3', HostCollectiveId: host2.id, currency: 'USD' });
        collective5 = await fakeCollective({ name: 'collective5', HostCollectiveId: host3.id, currency: 'USD' });
        organization = await fakeOrganization({ name: 'pubnub', currency: 'USD' });
        stripePaymentMethod = await fakePaymentMethod({
          name: '4242',
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          token: 'tok_testtoken123456789012345',
          CollectiveId: organization.id,
          monthlyLimitPerMember: 10000,
        });
      });

      beforeEach('create transactions for 3 donations from organization to collective1', async () => {
        transactions = [
          { amount: 500, netAmountInCollectiveCurrency: 500, amountInHostCurrency: 500 },
          { amount: 200, netAmountInCollectiveCurrency: 200, amountInHostCurrency: 200 },
          { amount: 1000, netAmountInCollectiveCurrency: 1000, amountInHostCurrency: 1000 },
        ];
        const transactionsDefaultValue = {
          CreatedByUserId: user1.id,
          FromCollectiveId: organization.id,
          CollectiveId: collective1.id,
          PaymentMethodId: stripePaymentMethod.id,
          currency: collective1.currency,
          hostCurrency: collective1.currency,
          HostCollectiveId: collective1.HostCollectiveId,
          type: TransactionTypes.DEBIT,
        };
        await models.Transaction.createManyDoubleEntry(transactions, transactionsDefaultValue);
      });

      beforeEach('create transactions for 3 donations from organization to collective5', async () => {
        transactions = [
          { amount: 500, netAmountInCollectiveCurrency: 500, amountInHostCurrency: 500 },
          { amount: 200, netAmountInCollectiveCurrency: 200, amountInHostCurrency: 200 },
          { amount: 1000, netAmountInCollectiveCurrency: 1000, amountInHostCurrency: 1000 },
        ];
        const transactionsDefaultValue = {
          CreatedByUserId: user1.id,
          FromCollectiveId: organization.id,
          CollectiveId: collective5.id,
          PaymentMethodId: stripePaymentMethod.id,
          currency: collective5.currency,
          hostCurrency: collective5.currency,
          HostCollectiveId: collective5.HostCollectiveId,
          type: TransactionTypes.DEBIT,
        };
        await models.Transaction.createManyDoubleEntry(transactions, transactionsDefaultValue);
      });

      beforeEach(() => {
        sandbox = createSandbox();
        // And given that the endpoint for creating customers on Stripe
        // is patched
        stubStripeCreate(sandbox, { charge: { currency: 'usd', status: 'succeeded' } });
        // And given the stripe stuff that depends on values in the
        // order struct is patch. It's here and not on each test because
        // the `totalAmount' field doesn't change throught the tests.
        stubStripeBalance(sandbox, ORDER_TOTAL_AMOUNT, 'usd', 0, STRIPE_FEE_STUBBED_VALUE); // This is the payment processor fee.
      });

      afterEach(() => sandbox.restore());

      it('the available balance of the payment method of the collective should be equal to the balance of the collective', async () => {
        // getting balance of transactions that were just created
        const reducer = (accumulator, currentValue) => accumulator + currentValue;
        const balance = transactions.map(t => t.netAmountInCollectiveCurrency).reduce(reducer, 0);

        // finding opencollective payment method for collective1
        const openCollectivePaymentMethod = await models.PaymentMethod.findOne({
          where: { type: 'collective', CollectiveId: collective1.id },
        });

        // get Balance given the created user
        const ocPaymentMethodBalance = await openCollectivePaymentMethod.getBalanceForUser(user1);

        expect(balance).to.equal(ocPaymentMethodBalance.amount);
        expect(collective1.currency).to.equal(ocPaymentMethodBalance.currency);
      });

      it("Non admin members can't use the payment method of the collective", async () => {
        // finding opencollective payment method for collective1
        const openCollectivePaymentMethod = await models.PaymentMethod.findOne({
          where: { type: 'collective', CollectiveId: collective1.id },
        });

        // get Balance given the created user
        const ocPaymentMethodBalance = await openCollectivePaymentMethod.getBalanceForUser(user1);

        // Setting up order
        const order = {
          fromAccount: { id: idEncode(collective1.id, 'account') },
          toAccount: { id: idEncode(collective2.id, 'account') },
          paymentMethod: { id: idEncode(openCollectivePaymentMethod.id, 'paymentMethod') },
          amount: { valueInCents: ocPaymentMethodBalance.amount, currency: 'USD' },
          frequency: 'ONETIME',
        };
        // Executing queries
        const res = await graphqlQueryV2(CREATE_ORDER_MUTATION, {
          order: { ...order, guestInfo: { email: randEmail() } },
        });
        const resWithUserParam = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user2);

        // Then there should be Errors for the Result of the query without any user defined as param
        expect(res.errors).to.exist;
        expect(res.errors).to.not.be.empty;
        expect(res.errors[0].message).to.contain('You need to be logged in to specify a contributing profile');

        // Logged out - no fromAccount
        const resWithoutFromCollective = await graphqlQueryV2(CREATE_ORDER_MUTATION, {
          order: { ...order, fromAccount: null, guestInfo: { email: randEmail() } },
        });
        expect(resWithoutFromCollective.errors).to.exist;
        expect(resWithoutFromCollective.errors).to.not.be.empty;
        expect(resWithoutFromCollective.errors[0].message).to.contain(
          'You need to be logged in to be able to use an existing payment method',
        );

        // Then there should also be Errors for the Result of the query through user2
        expect(resWithUserParam.errors).to.exist;
        expect(resWithUserParam.errors).to.not.be.empty;
        expect(resWithUserParam.errors[0].message).to.contain(
          "don't have sufficient permissions to create an order on behalf of the",
        );
      });

      it('Transactions between Collectives on the same host must have NO Fees', async () => {
        // Add user1 as an ADMIN of collective1
        await models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: MemberRoles.ADMIN,
        });

        // finding opencollective payment method for collective1
        const openCollectivePaymentMethod = await models.PaymentMethod.findOne({
          where: { type: 'collective', CollectiveId: collective1.id },
        });

        // get Balance given the created user
        const ocPaymentMethodBalance = await openCollectivePaymentMethod.getBalanceForUser(user1);

        // Setting up order
        const order = {
          fromAccount: { id: idEncode(collective1.id, 'account') },
          toAccount: { id: idEncode(collective2.id, 'account') },
          paymentMethod: { id: idEncode(openCollectivePaymentMethod.id, 'paymentMethod') },
          amount: { valueInCents: ocPaymentMethodBalance.amount, currency: 'USD' },
          frequency: 'ONETIME',
        };

        // Executing queries
        const res = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user1);

        // Then there should be no errors
        res.errors && console.error(res.errors);
        expect(res.errors).to.not.exist;

        // Then Find Created Transaction
        const orderFromCollective = res.data.createOrder.order.fromAccount;
        const orderCollective = res.data.createOrder.order.toAccount;
        const transaction = await models.Transaction.findOne({
          where: { CollectiveId: orderCollective.legacyId, amount: order.amount.valueInCents },
        });
        // Then Check whether Created Transaction has NO fees
        expect(transaction.FromCollectiveId).to.equal(orderFromCollective.legacyId);
        expect(orderCollective.legacyId).to.equal(collective2.id);
        expect(transaction.CollectiveId).to.equal(collective2.id);
        expect(transaction.currency).to.equal(collective2.currency);
        expect(transaction.platformFeeInHostCurrency).to.equal(0);
        expect(transaction.hostFeeInHostCurrency).to.equal(0);
        expect(transaction.paymentProcessorFeeInHostCurrency).to.equal(0);
      });

      it('Cannot send money that exceeds Collective balance', async () => {
        // Add user1 as an ADMIN of collective1
        await models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: MemberRoles.ADMIN,
        });

        // Create stripe connected account to host of collective1
        await stripeConnectedAccount(collective1.HostCollectiveId);
        // Add credit card to collective1
        await models.PaymentMethod.create({
          name: '4242',
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          token: 'tok_testtoken123456789012345',
          CollectiveId: collective1.HostCollectiveId,
          monthlyLimitPerMember: 10000,
        });
        // finding opencollective payment method for collective1
        const openCollectivePaymentMethod = await models.PaymentMethod.findOne({
          where: { type: 'collective', CollectiveId: collective1.id },
        });

        // get Balance given the created user
        const ocPaymentMethodBalance = await openCollectivePaymentMethod.getBalanceForUser(user1);

        // set an amount that's higher than the collective balance
        const amountHigherThanCollectiveBalance = ocPaymentMethodBalance.amount + 1;

        // Setting up order with amount higher than collective1 balance
        const order = {
          fromAccount: { id: idEncode(collective1.id, 'account') },
          toAccount: { id: idEncode(collective3.id, 'account') },
          paymentMethod: { id: idEncode(openCollectivePaymentMethod.id, 'paymentMethod') },
          amount: { valueInCents: amountHigherThanCollectiveBalance, currency: 'USD' },
          frequency: 'ONETIME',
        };

        // Executing queries
        const res = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user1);

        // Then there should be errors
        expect(res.errors).to.exist;
        expect(res.errors).to.not.be.empty;
        console.log(res.errors[0].message);
        expect(res.errors[0].message).to.contain(
          "You don't have enough funds available ($17.00 left) to execute this order ($17.01)",
        );
      });

      it('Recurring donations between Collectives with the same host must be allowed', async () => {
        // Add user1 as an ADMIN of collective1
        await models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: MemberRoles.ADMIN,
        });

        // Create stripe connected account to host of collective1
        await stripeConnectedAccount(collective1.HostCollectiveId);
        // Add credit card to collective1
        await models.PaymentMethod.create({
          name: '4242',
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          token: 'tok_testtoken123456789012345',
          CollectiveId: collective1.HostCollectiveId,
          monthlyLimitPerMember: 10000,
        });

        // finding opencollective payment method for collective1
        const openCollectivePaymentMethod = await models.PaymentMethod.findOne({
          where: { type: 'collective', CollectiveId: collective1.id },
        });

        // Setting up order with amount less than the credit card monthly limit
        const order = {
          fromAccount: { id: idEncode(collective1.id, 'account') },
          toAccount: { id: idEncode(collective2.id, 'account') },
          paymentMethod: { id: idEncode(openCollectivePaymentMethod.id, 'paymentMethod') },
          amount: { valueInCents: 1000, currency: 'USD' },
          frequency: 'MONTHLY',
        };
        // Executing queries
        const res = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user1);

        // Then there should be no errors
        res.errors && console.error(res.errors);
        expect(res.errors).to.not.exist;

        // When the order is created
        // Then the created transaction should match the requested data
        const orderCreated = res.data.createOrder.order;
        const orderCreatedCollective = orderCreated.toAccount;
        const orderCreatedFromCollective = orderCreated.fromAccount;
        const orderFromDb = await models.Order.findByPk(orderCreated.legacyId);
        const subscription = await orderFromDb.getSubscription();
        expect(subscription.interval).to.equal('month');
        expect(subscription.isActive).to.be.true;
        expect(subscription.amount).to.equal(order.amount.valueInCents);

        const transaction = await models.Transaction.findOne({
          where: {
            CollectiveId: orderCreatedCollective.legacyId,
            FromCollectiveId: orderCreatedFromCollective.legacyId,
            amount: order.amount.valueInCents,
          },
        });
        // make sure the transaction has been recorded
        expect(transaction.FromCollectiveId).to.equal(collective1.id);
        expect(transaction.CollectiveId).to.equal(collective2.id);
        expect(transaction.currency).to.equal(collective1.currency);
      });

      it('Recurring donations between Collectives with different hosts must not be allowed', async () => {
        // Add user1 as an ADMIN of collective1
        await models.Member.create({
          CreatedByUserId: user1.id,
          MemberCollectiveId: user1.CollectiveId,
          CollectiveId: collective1.id,
          role: MemberRoles.ADMIN,
        });

        // finding opencollective payment method for collective1
        const openCollectivePaymentMethod = await models.PaymentMethod.findOne({
          where: { type: 'collective', CollectiveId: collective1.id },
        });

        // Setting up order with amount less than the credit card monthly limit
        const order = {
          fromAccount: { id: idEncode(collective1.id, 'account') },
          toAccount: { id: idEncode(collective3.id, 'account') },
          paymentMethod: { id: idEncode(openCollectivePaymentMethod.id, 'paymentMethod') },
          amount: { valueInCents: 1000, currency: 'USD' },
          frequency: 'MONTHLY',
        };
        // Executing queries
        const res = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user1);

        // Then there should be errors
        expect(res.errors).to.exist;
        expect(res.errors).to.not.be.empty;
        expect(res.errors[0].message).to.contain(
          'Cannot use the Open Collective payment method to make a payment between different hosts',
        );
      });

      it('Host admin moves funds between collectives', async () => {
        const collective1InitialBalance = await collective1.getBalance();
        const collective2InitialBalance = await collective2.getBalance();
        const hostAdmin = await fakeUser();
        await host1.addUserWithRole(hostAdmin, 'ADMIN');
        const openCollectivePaymentMethod = await models.PaymentMethod.findOne({
          where: { type: 'collective', CollectiveId: collective1.id },
        });
        const result = await callCreateOrder(
          {
            order: {
              fromAccount: { legacyId: collective1.id },
              toAccount: { legacyId: collective2.id },
              amount: { valueInCents: 1000, currency: 'USD' },
              frequency: 'ONETIME',
              paymentMethod: { id: idEncode(openCollectivePaymentMethod.id, 'paymentMethod') },
            },
          },
          hostAdmin,
        );

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const order = result.data.createOrder.order;
        expect(order.status).to.equal('PAID');
        expect(order.amount.valueInCents).to.equal(1000);
        expect(order.amount.currency).to.equal('USD');

        expect(await collective1.getBalance()).to.equal(collective1InitialBalance - 1000);
        expect(await collective2.getBalance()).to.equal(collective2InitialBalance + 1000);
      });
    });
  });

  describe('createPendingOrder', () => {
    let validOrderPrams, host, hostAdmin, collectiveAdmin;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      host = await fakeHost({ admin: hostAdmin });
      const collective = await fakeCollective({ currency: 'USD', HostCollectiveId: host.id, admin: collectiveAdmin });
      const user = await fakeUser();
      const validAccountingCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'CONTRIBUTION' });
      validOrderPrams = {
        fromAccount: { legacyId: user.CollectiveId },
        toAccount: { legacyId: collective.id },
        amount: { valueInCents: 100e2, currency: 'USD' },
        accountingCategory: { id: idEncode(validAccountingCategory.id, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY) },
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
      expect(resultOrder.accountingCategory.id).to.equal(validOrderPrams.accountingCategory.id);
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

    describe('accounting category', () => {
      it('must exist', async () => {
        const orderInput = {
          ...validOrderPrams,
          accountingCategory: { id: idEncode(424242, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY) },
        };
        const result = await callCreatePendingOrder({ order: orderInput }, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Accounting category .+ not found/);
      });

      it('must belong to host', async () => {
        const otherHostAccountingCategory = await fakeAccountingCategory({ kind: 'CONTRIBUTION' });
        const orderInput = {
          ...validOrderPrams,
          accountingCategory: { id: idEncode(otherHostAccountingCategory.id, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY) },
        };
        const result = await callCreatePendingOrder({ order: orderInput }, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('This accounting category is not allowed for this host');
      });

      it('must be allowed for added funds', async () => {
        const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'EXPENSE' });
        const orderInput = {
          ...validOrderPrams,
          accountingCategory: { id: idEncode(accountingCategory.id, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY) },
        };
        const result = await callCreatePendingOrder({ order: orderInput }, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          'This accounting category is not allowed for contributions and added funds',
        );
      });
    });
  });

  describe('updateOrderAccountingCategory', () => {
    it('must be authenticated', async () => {
      const order = await fakeOrder();
      const result = await callUpdateOrderAccountingCategory({
        order: { legacyId: order.id },
        accountingCategory: null,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage orders');
    });

    it('must be host admin', async () => {
      const fromCollectiveAdmin = await fakeUser();
      const fromCollective = await fakeOrganization({ admin: fromCollectiveAdmin });
      const order = await fakeOrder({ FromCollectiveId: fromCollective.id });
      const orderReference = { legacyId: order.id };

      // Random user
      const randomUser = await fakeUser();
      const resultRandomUser = await callUpdateOrderAccountingCategory(
        { order: orderReference, accountingCategory: null },
        randomUser,
      );
      expect(resultRandomUser.errors).to.exist;
      expect(resultRandomUser.errors[0].message).to.equal(
        'Only host admins can update the accounting category of an order',
      );

      // Collective Admin
      const collectiveAdmin = await fakeUser();
      await order.collective.addUserWithRole(collectiveAdmin, 'ADMIN');
      const resultCollectiveAdmin = await callUpdateOrderAccountingCategory(
        { order: orderReference, accountingCategory: null },
        collectiveAdmin,
      );
      expect(resultCollectiveAdmin.errors).to.exist;
      expect(resultCollectiveAdmin.errors[0].message).to.equal(
        'Only host admins can update the accounting category of an order',
      );

      // From Collective Admin
      const resultFromCollectiveAdmin = await callUpdateOrderAccountingCategory(
        { order: orderReference, accountingCategory: null },
        fromCollectiveAdmin,
      );
      expect(resultFromCollectiveAdmin.errors).to.exist;
      expect(resultFromCollectiveAdmin.errors[0].message).to.equal(
        'Only host admins can update the accounting category of an order',
      );

      // Host Admin
      const hostAdmin = await fakeUser();
      await order.collective.host.addUserWithRole(hostAdmin, 'ADMIN');
      const resultHostAdmin = await callUpdateOrderAccountingCategory(
        { order: orderReference, accountingCategory: null },
        hostAdmin,
      );
      expect(resultHostAdmin.errors).to.not.exist;
    });

    it('cannot use expense categories', async () => {
      const hostAdmin = await fakeUser();
      const order = await fakeOrder();
      await order.collective.host.addUserWithRole(hostAdmin, 'ADMIN');
      const accountingCategory = await fakeAccountingCategory({
        CollectiveId: order.collective.HostCollectiveId,
        kind: 'EXPENSE',
      });
      const result = await callUpdateOrderAccountingCategory(
        {
          order: { legacyId: order.id },
          accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
        },
        hostAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'This accounting category is not allowed for contributions and added funds',
      );
    });

    it('cannot use categories from another host', async () => {
      const hostAdmin = await fakeUser();
      const order = await fakeOrder();
      await order.collective.host.addUserWithRole(hostAdmin, 'ADMIN');
      const otherHostAccountingCategory = await fakeAccountingCategory({ kind: 'CONTRIBUTION' });
      const result = await callUpdateOrderAccountingCategory(
        {
          order: { legacyId: order.id },
          accountingCategory: { id: idEncode(otherHostAccountingCategory.id, 'accounting-category') },
        },
        hostAdmin,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('This accounting category is not allowed for this host');
    });

    it('updates the accounting category of an order', async () => {
      const hostAdmin = await fakeUser();
      const order = await fakeOrder();
      await order.collective.host.addUserWithRole(hostAdmin, 'ADMIN');
      const accountingCategory = await fakeAccountingCategory({
        CollectiveId: order.collective.HostCollectiveId,
        kind: 'CONTRIBUTION',
      });
      const result = await callUpdateOrderAccountingCategory(
        {
          order: { legacyId: order.id },
          accountingCategory: { id: idEncode(accountingCategory.id, 'accounting-category') },
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.updateOrderAccountingCategory.accountingCategory.code).to.equal(accountingCategory.code);
    });
  });

  describe('editPendingOrder', () => {
    let order, host, hostAdmin, collectiveAdmin, validEditOrderParams;

    before(async () => {
      hostAdmin = await fakeUser();
      collectiveAdmin = await fakeUser();
      host = await fakeHost({ admin: hostAdmin });
      const collective = await fakeCollective({ currency: 'USD', HostCollectiveId: host.id, admin: collectiveAdmin });
      const user = await fakeUser();
      const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'CONTRIBUTION' });
      order = await fakeOrder({
        status: OrderStatuses.PENDING,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: collective.id,
        totalAmount: 1000,
        currency: 'USD',
        AccountingCategoryId: accountingCategory.id,
        data: {
          isPendingContribution: true,
        },
      });

      const newTier = await fakeTier({ CollectiveId: order.CollectiveId, currency: 'USD' });
      const newFromUser = await fakeUser();
      validEditOrderParams = {
        legacyId: order.id,
        tier: { legacyId: newTier.id },
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
      };
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
      const paidOrder = await fakeOrder({ status: OrderStatuses.PAID, data: { isPendingContribution: true } });
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

    it('must be a fiscal-host created pending contribution', async () => {
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
      expect(result.errors[0].message).to.equal(
        'Only pending contributions created by fiscal-host admins can be editted',
      );
    });

    it('edits a pending order', async () => {
      const result = await callEditPendingOrder({ order: validEditOrderParams }, hostAdmin);

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const resultOrder = result.data.editPendingOrder;
      expect(resultOrder.status).to.equal('PENDING');
      expect(resultOrder.amount.valueInCents).to.equal(18150); // $150 + $31.50 (21%) tax
      expect(resultOrder.amount.currency).to.equal('USD');
      expect(resultOrder.fromAccount.legacyId).to.equal(validEditOrderParams.fromAccount.legacyId);
      expect(resultOrder.tier.legacyId).to.equal(validEditOrderParams.tier.legacyId);
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

      // Make sure the accounting category is not reset if not provided
      expect(resultOrder.accountingCategory.id).to.equal(
        idEncode(order.AccountingCategoryId, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY),
      );
    });

    describe('accounting category', () => {
      it('must exist', async () => {
        const orderInput = {
          ...validEditOrderParams,
          accountingCategory: { id: idEncode(424242, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY) },
        };
        const result = await callEditPendingOrder({ order: orderInput }, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/Accounting category .+ not found/);
      });

      it('must belong to host', async () => {
        const otherHostAccountingCategory = await fakeAccountingCategory({ kind: 'CONTRIBUTION' });
        const orderInput = {
          ...validEditOrderParams,
          accountingCategory: { id: idEncode(otherHostAccountingCategory.id, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY) },
        };
        const result = await callEditPendingOrder({ order: orderInput }, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal('This accounting category is not allowed for this host');
      });

      it('must be allowed for added funds or contributions', async () => {
        const accountingCategory = await fakeAccountingCategory({ CollectiveId: host.id, kind: 'EXPENSE' });
        const orderInput = {
          ...validEditOrderParams,
          accountingCategory: { id: idEncode(accountingCategory.id, IDENTIFIER_TYPES.ACCOUNTING_CATEGORY) },
        };
        const result = await callEditPendingOrder({ order: orderInput }, hostAdmin);
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.equal(
          'This accounting category is not allowed for contributions and added funds',
        );
      });

      it('can be set to null', async () => {
        const orderInput = { ...validEditOrderParams, accountingCategory: null };
        const result = await callEditPendingOrder({ order: orderInput }, hostAdmin);
        expect(result.errors).to.not.exist;
        const resultOrder = result.data.editPendingOrder;
        expect(resultOrder.accountingCategory).to.be.null;
      });
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
      await fakeConnectedAccount({
        service: 'stripe',
        username: 'host_stripe_account',
        CollectiveId: host.id,
      });
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

      it('cannot update an order with a payment method not valid for the host', async () => {
        const host = await fakeActiveHost();
        await fakeConnectedAccount({
          service: 'stripe',
          username: 'valid_stripe_account',
          CollectiveId: host.id,
        });
        const collective = await fakeCollective({
          HostCollectiveId: host.id,
        });
        const order = await fakeOrder(
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

        const paymentMethod = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          data: {
            expMonth: 11,
            expYear: 2025,
            stripeAccount: 'invalid_stripe_account',
          },
          CollectiveId: user.CollectiveId,
        });

        const result = await graphqlQueryV2(
          updateOrderMutation,
          {
            order: { id: idEncode(order.id, 'order') },
            paymentMethod: {
              id: idEncode(paymentMethod.id, 'paymentMethod'),
            },
          },
          user,
        );
        expect(result.errors).to.exist;
        expect(result.errors[0].message).to.match(/This payment method is not valid for the order host/);
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
          const monthlyOrder = await fakeOrder(
            {
              interval: 'month',
              CreatedByUserId: user.id,
              FromCollectiveId: user.CollectiveId,
              CollectiveId: collective.id,
              status: OrderStatuses.ACTIVE,
            },
            { withSubscription: true, subscription: { nextChargeDate: moment(today) } },
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
            include: [{ association: 'Subscription', required: true }],
          });

          expect(updatedOrder.Subscription.nextChargeDate.toISOString()).to.equal('2023-01-01T00:00:00.000Z');
          expect(updatedOrder.Subscription.nextPeriodStart.toISOString()).to.equal('2023-01-01T00:00:00.000Z');
        });

        it('from yearly to monthly (before the 15th of the month)', async () => {
          const today = moment(new Date(2022, 0, 1)); // 1st of January 2022
          clock = useFakeTimers(today.toDate()); // Manually setting today's date
          const yearlyOrder = await fakeOrder(
            {
              interval: 'year',
              CreatedByUserId: user.id,
              FromCollectiveId: user.CollectiveId,
              CollectiveId: collective.id,
              status: OrderStatuses.ACTIVE,
            },
            { withSubscription: true, subscription: { nextChargeDate: moment(today) } },
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
            include: [{ association: 'Subscription', required: true }],
          });

          expect(updatedOrder.Subscription.nextChargeDate.toISOString()).to.equal('2022-02-01T00:00:00.000Z');
          expect(updatedOrder.Subscription.nextPeriodStart.toISOString()).to.equal('2022-02-01T00:00:00.000Z');
        });

        it('from yearly to monthly (after the 15th of the month)', async () => {
          const today = moment(new Date(2022, 0, 18)); // 18th of January 2022
          clock = useFakeTimers(today.toDate()); // Manually setting today's date
          const yearlyOrder = await fakeOrder(
            {
              interval: 'year',
              CreatedByUserId: user.id,
              FromCollectiveId: user.CollectiveId,
              CollectiveId: collective.id,
              status: OrderStatuses.ACTIVE,
            },
            { withSubscription: true, subscription: { nextChargeDate: moment(today) } },
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
            include: [{ association: 'Subscription', required: true }],
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

        result.errors && console.error(result.errors);
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

        result.errors && console.error(result.errors);
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

      result.errors && console.error(result.errors);
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
