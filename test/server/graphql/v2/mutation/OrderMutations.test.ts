import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import sinon from 'sinon';

import * as payments from '../../../../../server/lib/payments';
import models from '../../../../../server/models';
import { randEmail } from '../../../../stores';
import { fakeCollective, fakeHost, fakeTier, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';

const CREATE_ORDER_MUTATION = gqlV2/* GraphQL */ `
  mutation CreateOrder($order: OrderCreateInput!) {
    createOrder(order: $order) {
      order {
        id
        status
        quantity
        frequency
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
          ... on Individual {
            isGuest
          }
        }
        paymentMethod {
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
  let fromUser, toCollective, host, validOrderParams, sandbox;

  before(async () => {
    fromUser = await fakeUser();

    // Stub the payment
    sandbox = sinon.createSandbox();
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
        type: 'CREDIT_CARD',
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

  describe('createOrder', () => {
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
        expect(order.amount.valueInCents).to.eq(7500);
        expect(order.platformContributionAmount.valueInCents).to.eq(2500);
      });

      it('can add taxes', async () => {
        // TODO
      });

      it('respects the isSavedForLater param', async () => {
        // TODO
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
        const orderData = { ...validOrderParams, fromAccount: null, guestInfo: { email } };
        const result = await callCreateOrder({ order: orderData });
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;

        const order = result.data.createOrder.order;
        expect(order.fromAccount.isGuest).to.eq(true);
        expect(order.paymentMethod.account.id).to.eq(order.fromAccount.id);
        expect(order.status).to.eq('PAID');
      });

      it('Rejects if no email/guest token is provided and amount requires it', async () => {
        // TODO
        // expect(result.errors).to.exist;
      });

      it('requires you to confirm your email when the sum of your contributions is > $250', async () => {
        // TODO
      });
    });
  });
});
