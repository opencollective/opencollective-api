/* eslint-disable camelcase */
import { expect } from 'chai';
import { createSandbox } from 'sinon';

import OrderStatuses from '../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE } from '../../server/constants/paymentMethods';
import PlatformConstants from '../../server/constants/platform';
import stripe from '../../server/lib/stripe';
import { ConnectedAccount, Order, User } from '../../server/models';
import { paymentIntentSucceeded } from '../../server/paymentProviders/stripe/webhook';
import { fakeActiveHost, fakeCollective, fakeOrganization, fakeUser, randStr } from '../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../utils';

describe('stripe', () => {
  describe('payment intent flow', async () => {
    let sandbox;
    let makeContribution: (
      orderData?: any,
      user?: User,
    ) => Promise<{ errors?: any[]; data?: { createOrder: { order: { legacyId: number; status: string } } } }>;
    let fakePaymentIntentSucceeded: () => void;

    beforeEach(async () => {
      await resetTestDB();
      await fakeOrganization({
        id: PlatformConstants.PlatformCollectiveId,
        slug: randStr('platform-'),
      });
      const host = await fakeActiveHost();
      await ConnectedAccount.create({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        token: 'abc',
        CollectiveId: host.id,
      });
      const collective = await fakeCollective({
        HostCollectiveId: host.id,
      });
      const user = await fakeUser();

      const stripePaymentIntentOrderData = {
        frequency: 'ONETIME',
        paymentMethod: {
          service: 'STRIPE',
          newType: 'PAYMENT_INTENT',
          paymentIntentId: randStr('payment-intent-id-'),
        },
        amount: {
          valueInCents: 5000,
        },
        fromAccount: { legacyId: user.CollectiveId },
        toAccount: { legacyId: collective.id },
      };

      sandbox = createSandbox();

      let paymentIntent;
      sandbox.stub(stripe.paymentIntents, 'update').callsFake((id, params, options) => {
        paymentIntent = { id, ...params, ...options };
        return paymentIntent;
      });

      let paymentMethod;
      sandbox.stub(stripe.paymentMethods, 'retrieve').callsFake((id, options) => {
        paymentMethod = {
          id,
          type: 'card',
          card: {
            brand: 'visa',
            country: 'US',
            exp_year: 2050,
            exp_month: 10,
            fingerprint: randStr('stripe-pm-fingerprint-'),
          },
          ...options,
        };
        return paymentMethod;
      });

      let balanceTransaction;
      sandbox.stub(stripe.balanceTransactions, 'retrieve').callsFake((id, options) => {
        balanceTransaction = { id, currency: 'usd', amount: 5000, fee: 0, fee_details: [], ...options };
        return balanceTransaction;
      });

      makeContribution = (orderData = stripePaymentIntentOrderData, remoteUser = user) => {
        return graphqlQueryV2(
          `
            mutation CreateOrder($order: OrderCreateInput!) {
                createOrder(order: $order) {
                    order {
                        legacyId
                        status
                        transactions {
                            id
                        }
                    }
                }
            }
            `,
          {
            order: orderData,
          },
          remoteUser,
        );
      };

      fakePaymentIntentSucceeded = async (stripePaymentIntent = paymentIntent) => {
        const stripeChargeId = randStr('stripe-charge-id-');
        const stripePaymentMethodId = randStr('stripe-payment-method-id-');
        const stripeBalanceTransactionId = randStr('stripe-balance-transaction-id-');
        await paymentIntentSucceeded({
          account: stripePaymentIntent.stripeAccount,
          data: {
            object: {
              ...stripePaymentIntent,
              charges: {
                data: [
                  {
                    id: stripeChargeId,
                    balance_transaction: stripeBalanceTransactionId,
                  },
                ],
              },
              payment_method: {
                id: stripePaymentMethodId,
              },
            },
          },
        } as any);
      };
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('handles credit card payment successfuly', async () => {
      const result = await makeContribution();
      const orderId = result.data.createOrder.order.legacyId;
      const order = await Order.findByPk(orderId);
      expect(order).to.exist;
      expect(order.status).to.eql(OrderStatuses.NEW);

      await fakePaymentIntentSucceeded();

      await order.reload();
      expect(order.status).to.eql(OrderStatuses.PAID);
      expect(order.getTransactions()).to.eventually.have.length(4);
    });

    it('cannot reuse previously used payment intent id', async () => {
      let result = await makeContribution();
      const orderId = result.data.createOrder.order.legacyId;
      const order = await Order.findByPk(orderId);
      expect(order).to.exist;
      expect(order.status).to.eql(OrderStatuses.NEW);

      // try createOrderAgain
      result = await makeContribution();
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.eql('Payment intent already used for another order');
    });
  });
});
