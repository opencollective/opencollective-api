/* eslint-disable camelcase */

import { expect } from 'chai';
import nock from 'nock';
import { assert, createSandbox } from 'sinon';

import OrderStatuses from '../../../../server/constants/order_status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import * as PaypalAPI from '../../../../server/paymentProviders/paypal/api';
import {
  cancelPaypalSubscription,
  setupPaypalSubscriptionForOrder,
} from '../../../../server/paymentProviders/paypal/subscription';
import { randEmail } from '../../../stores';
import {
  fakeConnectedAccount,
  fakeHost,
  fakeOrder,
  fakePaymentMethod,
  fakePaypalPlan,
  randStr,
} from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const nockPayPalGetCredentials = () =>
  nock('https://api.sandbox.paypal.com:443')
    .post('/v1/oauth2/token', 'grant_type=client_credentials')
    .reply(
      200,
      {
        scope:
          'https://uri.paypal.com/services/subscriptions https://api.paypal.com/v1/payments/.* https://api.paypal.com/v1/vault/credit-card https://uri.paypal.com/services/applications/webhooks openid https://uri.paypal.com/payments/payouts https://api.paypal.com/v1/vault/credit-card/.*',
        nonce: '2016-08-03T21:01:22ZcIbqjVI2MPTodCz4VkKZptGUDo0l77kE0W9HJCarniE',
        access_token:
          'A101.gP5cjIGBF4eAVuq_hTrafQ7F_DqZ0FPqNgi_OnDAP31Pf8r-9GRbtYR5HyN-bjQ0.LeHej6pGR28T6nKme0E1MCB-3cC',
        token_type: 'Bearer',
        app_id: 'APP-80W284485P519543T',
        expires_in: 31244,
      },
      {
        date: 'Wed, 03 Aug 2016 21:20:38 GMT',
        server: 'Apache',
        proxy_server_info: 'host=slcsbplatformapiserv3002.slc.paypal.com;threadId=1401',
        'paypal-debug-id': 'b0f91a413f6f1, b0f91a413f6f1',
        'correlation-id': 'b0f91a413f6f1',
        'x-paypal-token-service': 'IAAS',
        connection: 'close',
        'set-cookie': [
          'X-PP-SILOVER=name%3DSANDBOX3.API.1%26silo_version%3D1880%26app%3Dplatformapiserv%26TIME%3D643867223%26HTTP_X_PP_AZ_LOCATOR%3D; Expires=Wed, 03 Aug 2016 21:50:38 GMT; domain=.paypal.com; path=/; Secure; HttpOnly',
          'X-PP-SILOVER=; Expires=Thu, 01 Jan 1970 00:00:01 GMT',
        ],
        vary: 'Authorization',
        'content-length': '550',
        'content-type': 'application/json',
      },
    );

const fakePaypalSubscriptionPm = subscription => {
  return fakePaymentMethod({
    service: PAYMENT_METHOD_SERVICE.PAYPAL,
    type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
    token: subscription.id,
  });
};

describe('server/paymentProviders/paypal/subscription', () => {
  let sandbox, host, plan, validSubscriptionParams;

  before(async () => {
    // Create host with PayPal
    await resetTestDB();
    host = await fakeHost();
    await fakeConnectedAccount({ service: 'paypal', clientId: randStr(), token: randStr(), CollectiveId: host.id });
    sandbox = createSandbox();
    plan = await fakePaypalPlan({ product: { CollectiveId: host.id }, amount: 1000, interval: 'month' });
  });

  beforeEach(() => {
    validSubscriptionParams = {
      id: randStr(),
      status: 'APPROVED',
      plan_id: plan.id,
      subscriber: {
        email_address: randEmail(),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('setupPaypalSubscriptionForOrder', () => {
    it('activates the subscription when params are valid', async () => {
      const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
      const order = await fakeOrder({
        CollectiveId: host.id,
        status: OrderStatuses.NEW,
        TierId: null,
        totalAmount: 1000,
      });
      const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
      const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
      paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
      paypalRequestStub.withArgs(`${subscriptionUrl}/activate`).resolves();
      await setupPaypalSubscriptionForOrder(order, paymentMethod);
      assert.calledWith(paypalRequestStub, `${subscriptionUrl}/activate`);
      const createdSubscription = await order.getSubscription();
      expect(createdSubscription.paypalSubscriptionId).to.eq(validSubscriptionParams.id);
      expect(createdSubscription.isActive).to.be.false; // Will be activated when the first payment hits
    });

    describe('subscription matches the contribution', () => {
      it('must be APPROVED', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
        const order = await fakeOrder({
          CollectiveId: host.id,
          status: OrderStatuses.NEW,
          PaymentMethodId: paymentMethod.id,
        });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns({ ...validSubscriptionParams, status: 'ACTIVE' });
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq('Subscription must be approved to be activated');
        assert.calledOnce(paypalRequestStub); // We only fetch the subscription, not approving it
      });

      it('must have an existing plan', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
        const order = await fakeOrder({ CollectiveId: host.id, status: OrderStatuses.NEW, TierId: null });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns({ ...validSubscriptionParams, plan_id: 'xxxxxxx' });
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq(
          `PayPal plan does not match the subscription (#${validSubscriptionParams.id})`,
        );
        assert.calledOnce(paypalRequestStub); // We only fetch the subscription, not approving it
      });

      it('must have a plan that match amount', async () => {
        const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
        const order = await fakeOrder({
          CollectiveId: host.id,
          status: OrderStatuses.NEW,
          TierId: null,
          totalAmount: 5000,
        });
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const subscriptionUrl = `billing/subscriptions/${paymentMethod.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
        const error = await setupPaypalSubscriptionForOrder(order, paymentMethod).catch(e => e);
        expect(error).to.exist;
        expect(error['rootException'].message).to.eq('The plan amount does not match the order amount');
        assert.calledOnce(paypalRequestStub); // We only fetch the subscription, not approving it
      });
    });

    describe('when a subscription already exists', () => {
      const generateOrderWithSubscription = async () => {
        const paypalSubscriptionId = randStr();
        const paymentMethod = await fakePaypalSubscriptionPm({ ...validSubscriptionParams, id: paypalSubscriptionId });
        return fakeOrder(
          {
            CollectiveId: host.id,
            status: OrderStatuses.NEW,
            TierId: null,
            totalAmount: 1000,
            subscription: { paypalSubscriptionId, isActive: false },
            PaymentMethodId: paymentMethod.id,
          },
          {
            withSubscription: true,
          },
        );
      };

      it('cancels/updates existing subscription', async () => {
        const order = await generateOrderWithSubscription();
        const previousSubscription = order.Subscription;
        const newSubscriptionPm = await fakePaypalSubscriptionPm({ ...validSubscriptionParams, id: randStr() });

        // PayPal API stubs
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const oldSubscriptionUrl = `billing/subscriptions/${order.paymentMethod.token}`;
        const subscriptionUrl = `billing/subscriptions/${newSubscriptionPm.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
        paypalRequestStub.withArgs(`${subscriptionUrl}/activate`).resolves();
        paypalRequestStub.withArgs(`${oldSubscriptionUrl}/cancel`).resolves();

        await setupPaypalSubscriptionForOrder(order, newSubscriptionPm);
        assert.calledWith(paypalRequestStub, subscriptionUrl);
        assert.calledWith(paypalRequestStub, `${subscriptionUrl}/activate`);
        assert.calledWith(paypalRequestStub, `${oldSubscriptionUrl}/cancel`);

        const updatedSubscription = await order.getSubscription();
        expect(updatedSubscription.paypalSubscriptionId).to.eq(newSubscriptionPm.token);
        expect(previousSubscription.isActive).to.be.false;
        expect(updatedSubscription.id).to.eq(previousSubscription.id);
      });

      it('does nothing if cancellation fails', async () => {
        const order = await generateOrderWithSubscription();
        const newSubscriptionPm = await fakePaypalSubscriptionPm({ ...validSubscriptionParams, id: randStr() });

        // PayPal API stubs
        const paypalRequestStub = sandbox.stub(PaypalAPI, 'paypalRequest');
        const oldSubscriptionUrl = `billing/subscriptions/${order.paymentMethod.token}`;
        const subscriptionUrl = `billing/subscriptions/${newSubscriptionPm.token}`;
        paypalRequestStub.withArgs(subscriptionUrl).returns(validSubscriptionParams);
        paypalRequestStub.withArgs(`${subscriptionUrl}/activate`).resolves();
        paypalRequestStub.withArgs(`${oldSubscriptionUrl}/cancel`).rejects();

        await expect(setupPaypalSubscriptionForOrder(order, newSubscriptionPm)).to.be.rejected;
        assert.calledWith(paypalRequestStub, subscriptionUrl);
        assert.calledWith(paypalRequestStub, `${oldSubscriptionUrl}/cancel`);
        assert.callCount(paypalRequestStub, 2); // Must NOT call activate if cancellation fails
      });
    });
  });

  describe('cancelPaypalSubscription', () => {
    it('ignores if the subscription is already cancelled', async () => {
      const paymentMethod = await fakePaypalSubscriptionPm(validSubscriptionParams);
      const order = await fakeOrder(
        {
          CollectiveId: host.id,
          status: OrderStatuses.NEW,
          TierId: null,
          totalAmount: 1000,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );

      await nockPayPalGetCredentials();
      const paypalNock = nock('https://api.sandbox.paypal.com:443')
        .post(`/v1/billing/subscriptions/${paymentMethod.token}/cancel`, { reason: 'Test cancellation' })
        .reply(422, {
          details: [
            {
              description:
                'Invalid subscription status for cancel action; subscription status should be active or suspended.',
              issue: 'SUBSCRIPTION_STATUS_INVALID',
            },
          ],
          message:
            'The requested action could not be performed, semantically incorrect, or failed business validation.',
          name: 'UNPROCESSABLE_ENTITY',
          status: 422,
        });

      await cancelPaypalSubscription(order, 'Test cancellation');
      expect(paypalNock.isDone()).to.be.true;
    });
  });
});
