import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import INTERVALS from '../../../server/constants/intervals.js';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../server/constants/paymentMethods.js';
import { updatePaymentMethodForSubscription } from '../../../server/lib/subscriptions.js';
import * as PaypalSubscriptionAPI from '../../../server/paymentProviders/paypal/subscription.js';
import { fakeOrder, fakePaymentMethod } from '../../test-helpers/fake-data.js';
import { resetTestDB } from '../../utils.js';

describe('server/lib/subscriptions', () => {
  let sandbox;

  beforeEach(async () => {
    await resetTestDB();
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('updatePaymentMethodForSubscription', () => {
    describe('when going from managed externally to managed internally', () => {
      describe('sets the next charge date', () => {
        let clock;

        afterEach(() => {
          if (clock) {
            clock.restore();
            clock = null;
          }
        });

        describe('with an order that has a pending payment', () => {
          it('to what it was before, keep the past due date', async () => {
            const today = moment(new Date(2022, 0, 1)); // 1st of January 2022
            clock = sinon.useFakeTimers(today.toDate()); // Manually setting today's date
            const paypalPm = await fakePaymentMethod({
              service: PAYMENT_METHOD_SERVICE.PAYPAL,
              type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
            });
            const subscription = { nextChargeDate: moment(today).subtract(1, 'days') }; // Past payment: 2021-12-31
            const order = await fakeOrder(
              { PaymentMethodId: paypalPm.id, interval: INTERVALS.MONTH, subscription },
              { withSubscription: true },
            );

            const user = order.createdByUser;
            const newPaymentMethod = await fakePaymentMethod({
              CollectiveId: user.CollectiveId,
              service: PAYMENT_METHOD_SERVICE.STRIPE,
              type: PAYMENT_METHOD_TYPE.CREDITCARD,
            });

            sandbox.stub(PaypalSubscriptionAPI, 'cancelPaypalSubscription').resolves();
            const updatedOrder = await updatePaymentMethodForSubscription(user, order, newPaymentMethod);
            const expectedNextChargeDate = subscription.nextChargeDate.toISOString();
            expect(updatedOrder.Subscription.nextChargeDate.toISOString()).to.equal(expectedNextChargeDate);
            expect(updatedOrder.Subscription.nextPeriodStart.toISOString()).to.equal(expectedNextChargeDate);
          });
        });

        describe('with an order that has a future payment', () => {
          it('before the 15th of the month => 1st of next month', async () => {
            const today = moment(new Date(2022, 0, 1)); // 1st of January 2022
            clock = sinon.useFakeTimers(today.toDate()); // Manually setting today's date
            const paypalPm = await fakePaymentMethod({
              service: PAYMENT_METHOD_SERVICE.PAYPAL,
              type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
            });
            const subscription = { nextChargeDate: moment(today).add(5, 'days') }; // Future payment: 2022-01-06
            const order = await fakeOrder(
              { PaymentMethodId: paypalPm.id, interval: INTERVALS.MONTH, subscription },
              { withSubscription: true },
            );

            const user = order.createdByUser;
            const newPaymentMethod = await fakePaymentMethod({
              CollectiveId: user.CollectiveId,
              service: PAYMENT_METHOD_SERVICE.STRIPE,
              type: PAYMENT_METHOD_TYPE.CREDITCARD,
            });

            sandbox.stub(PaypalSubscriptionAPI, 'cancelPaypalSubscription').resolves();
            const updatedOrder = await updatePaymentMethodForSubscription(user, order, newPaymentMethod);
            expect(updatedOrder.Subscription.nextChargeDate.toISOString()).to.equal('2022-02-01T00:00:00.000Z');
            expect(updatedOrder.Subscription.nextPeriodStart.toISOString()).to.equal('2022-02-01T00:00:00.000Z');
          });

          it('after the 15th of the month => skip next month', async () => {
            const today = moment(new Date(2022, 0, 18)); // 18th of January 2022
            clock = sinon.useFakeTimers(today.toDate()); // Manually setting today's date
            const paypalPm = await fakePaymentMethod({
              service: PAYMENT_METHOD_SERVICE.PAYPAL,
              type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
            });
            const subscription = { nextChargeDate: moment(today).add(5, 'days') }; // Future payment: 2022-01-23
            const order = await fakeOrder(
              { PaymentMethodId: paypalPm.id, interval: INTERVALS.MONTH, subscription },
              { withSubscription: true },
            );

            const user = order.createdByUser;
            const newPaymentMethod = await fakePaymentMethod({
              CollectiveId: user.CollectiveId,
              service: PAYMENT_METHOD_SERVICE.STRIPE,
              type: PAYMENT_METHOD_TYPE.CREDITCARD,
            });

            sandbox.stub(PaypalSubscriptionAPI, 'cancelPaypalSubscription').resolves();
            const updatedOrder = await updatePaymentMethodForSubscription(user, order, newPaymentMethod);
            expect(updatedOrder.Subscription.nextChargeDate.toISOString()).to.equal('2022-03-01T00:00:00.000Z');
            expect(updatedOrder.Subscription.nextPeriodStart.toISOString()).to.equal('2022-03-01T00:00:00.000Z');
          });
        });
      });

      it('resets the flags for contributions managed externally', async () => {
        const paypalPm = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.PAYPAL,
          type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
        });
        const order = await fakeOrder(
          { PaymentMethodId: paypalPm.id, interval: INTERVALS.MONTH },
          { withSubscription: true },
        );

        const user = order.createdByUser;
        const newPaymentMethod = await fakePaymentMethod({
          CollectiveId: user.CollectiveId,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
        });

        sandbox.stub(PaypalSubscriptionAPI, 'cancelPaypalSubscription').resolves();
        const updatedOrder = await updatePaymentMethodForSubscription(user, order, newPaymentMethod);
        expect(updatedOrder.Subscription.isManagedExternally).to.be.false;
        expect(updatedOrder.Subscription.paypalSubscriptionId).to.be.null;
      });

      it('deactivates the previous subscription', async () => {
        const cancelPaypalSubscriptionStub = sandbox.stub(PaypalSubscriptionAPI, 'cancelPaypalSubscription').resolves();
        const paypalPm = await fakePaymentMethod({
          service: PAYMENT_METHOD_SERVICE.PAYPAL,
          type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
        });
        const order = await fakeOrder(
          { PaymentMethodId: paypalPm.id, interval: INTERVALS.MONTH, subscription: { paypalSubscriptionId: 'XXXXXX' } },
          { withSubscription: true },
        );

        const user = order.createdByUser;
        const newPaymentMethod = await fakePaymentMethod({
          CollectiveId: user.CollectiveId,
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
        });

        await updatePaymentMethodForSubscription(user, order, newPaymentMethod);
        expect(cancelPaypalSubscriptionStub.calledOnce).to.be.true;
      });
    });
  });
});
