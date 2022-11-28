/* eslint-disable camelcase */

import { expect } from 'chai';
import { set } from 'lodash';
import sinon from 'sinon';

import FEATURE from '../../../../server/constants/feature';
import OrderStatuses from '../../../../server/constants/order_status';
import * as libPayments from '../../../../server/lib/payments';
import * as common from '../../../../server/paymentProviders/stripe/common';
import * as webhook from '../../../../server/paymentProviders/stripe/webhook';
import stripeMocks from '../../../mocks/stripe';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeOrder,
  fakePaymentMethod,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('webhook', () => {
  describe('chargeDisputeCreated()', () => {
    let order, user;

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      const tx = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          amount: 10,
          data: { charge: { id: stripeMocks.webhook_dispute_created.data.object.charge } },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: tx.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );

      await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
    });

    it('limits Orders for User account', async () => {
      await user.reload();
      expect(user.data.features[FEATURE.ORDER]).to.eq(false);
    });

    it('disputes all Transactions connected to the charge', async () => {
      const transactions = await order.getTransactions();
      expect(transactions.map(tx => tx.isDisputed)).to.eql([true, true, true, true]);
    });

    it('disputes the Order connected to the charge', async () => {
      await order.reload();
      expect(order.status).to.eql(OrderStatuses.DISPUTED);
    });

    it('deactivates the Subscription connected to the charge', async () => {
      const subscription = await order.getSubscription();
      expect(subscription.isActive).to.eql(false);
    });
  });

  describe('chargeDisputeClosed()', () => {
    let order, user, paymentMethod;

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      const collective = await fakeCollective({ isHostAccount: true });
      paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      const tx = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          HostCollectiveId: collective.id,
          amount: 10,
          data: { charge: { id: stripeMocks.webhook_dispute_created.data.object.charge } },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: tx.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );
    });

    describe('the dispute was won and is not fraud', () => {
      it('un-disputes all Transactions connected to the charge', async () => {
        await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
        await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won as any);

        const transactions = await order.getTransactions();
        expect(transactions.map(tx => tx.isDisputed)).to.eql([false, false, false, false]);
      });

      describe('when the Order has a Subscription', () => {
        it('resets the Order connected to the charge to ACTIVE', async () => {
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.ACTIVE);
        });

        it('reactivates the Subscription', async () => {
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won as any);

          const subscription = await order.getSubscription();
          expect(subscription.isActive).to.eql(true);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('resets the Order connected to the charge to PAID', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.PAID);
        });
      });

      describe('when the User has other disputed Orders', () => {
        it('does not remove the Order limit from the User', async () => {
          await fakeOrder(
            {
              CreatedByUserId: user.id,
              totalAmount: 20,
              PaymentMethodId: paymentMethod.id,
              status: OrderStatuses.DISPUTED,
            },
            { withSubscription: true },
          );
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won as any);

          await user.reload();
          expect(user.data.features[FEATURE.ORDER]).to.eq(false);
        });
      });

      describe('when the User does not have other disputed Orders', () => {
        it('removes the Order limit from the User', async () => {
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won as any);

          await user.reload();
          expect(user.data.features[FEATURE.ORDER]).to.eq(true);
        });
      });
    });

    describe('the dispute was lost and is fraud', () => {
      it('creates a refund transaction for the fraudulent transaction', async () => {
        await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
        await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost as any);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });

      it('creates a dispute fee DEBIT transaction for the host collective', async () => {
        await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
        await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost as any);

        const transactions = await order.getTransactions();
        const disputeFeeTransaction = transactions.find(tx => tx.description === 'Stripe Transaction Dispute Fee');
        expect(disputeFeeTransaction.amount).to.eql(-1500);
      });

      describe('when the Order has a Subscription', () => {
        it('resets the Order connected to the charge to CANCELLED', async () => {
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('resets the Order connected to the charge to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created as any);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });
    });
  });

  describe('reviewOpened()', () => {
    let order, user;

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      const tx = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          amount: 10,
          data: { charge: { payment_intent: stripeMocks.webhook_review_opened.data.object.payment_intent } },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: tx.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );

      await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
    });

    it('updates isInReview status of all Transactions connected to the charge', async () => {
      const transactions = await order.getTransactions();
      expect(transactions.map(tx => tx.isInReview)).to.eql([true, true, true, true]);
    });

    it('changes status to IN_REVIEW of the Order connected to the charge', async () => {
      await order.reload();
      expect(order.status).to.eql(OrderStatuses.IN_REVIEW);
    });

    it('deactivates the Subscription connected to the charge', async () => {
      const subscription = await order.getSubscription();
      expect(subscription.isActive).to.eql(false);
    });
  });

  describe('reviewClosed()', () => {
    let order, user;

    beforeEach(() => utils.resetTestDB());

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({ service: 'stripe', type: 'creditcard' });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      const tx = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          amount: 10,
          data: { charge: { payment_intent: stripeMocks.webhook_review_opened.data.object.payment_intent } },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: tx.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );
    });

    describe('when review is "approved"', () => {
      it('updates isInReview status of all Transactions connected to the charge', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_approved as any);

        const transactions = await order.getTransactions();
        expect(transactions.map(tx => tx.isInReview)).to.eql([false, false, false, false]);
      });

      describe('when the Order has a Subscription', () => {
        it('reactivates the Subscription connected to the charge', async () => {
          await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_approved as any);

          const subscription = await order.getSubscription();
          expect(subscription.isActive).to.eql(true);
        });

        it('changes Order status back to ACTIVE', async () => {
          await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_approved as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.ACTIVE);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to PAID', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_approved as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.PAID);
        });
      });
    });

    describe('when review is "refunded_as_fraud"', () => {
      describe('when the Order has a Subscription', () => {
        it('changes Order status to CANCELLED', async () => {
          await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded_as_fraud as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded_as_fraud as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });

      it('limits Orders for User account', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded_as_fraud as any);

        await user.reload();
        expect(user.data.features[FEATURE.ORDER]).to.eq(false);
      });

      it('creates a refund transaction for the fraudulent transaction', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded_as_fraud as any);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });
    });

    describe('when review is "refunded"', () => {
      describe('when the Order has a Subscription', () => {
        it('changes Order status to CANCELLED', async () => {
          await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded as any);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });

      it('does not limit Orders for User account', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded as any);

        await user.reload();
        expect(user.data).to.eq(null);
      });

      it('creates a refund transaction for the fraudulent transaction', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded as any);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });

      it('updates all related transactions to remove in review status', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened as any);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded as any);

        const transactions = await order.getTransactions();
        expect(transactions.every(tx => tx.isInReview === false)).to.eql(true);
      });
    });
  });

  describe('paymentIntent', () => {
    let order, event;
    const sandbox = sinon.createSandbox();

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({ type: 'paymentintent', service: 'stripe' });
      order = await fakeOrder({
        PaymentMethodId: paymentMethod.id,
        FromCollectiveId: paymentMethod.CollectiveId,
        status: OrderStatuses.PROCESSING,
        totalAmount: 100e2,
        description: 'Do you even donate, brah?!',
        data: { paymentIntent: { id: randStr('pi_fake') } },
      });
      const hostId = order.collective.HostCollectiveId;
      await fakeConnectedAccount({
        CollectiveId: hostId,
        service: 'stripe',
        username: 'testUserName',
        token: 'faketoken',
      });

      event = {
        data: {
          object: {
            id: order.data.paymentIntent.id,
            charges: {
              data: [
                {
                  amount: 100e2,
                  amount_captured: 100e2,
                  amount_refunded: 0,
                  application_fee: null,
                  application_fee_amount: null,
                },
              ],
            },
          },
        },
      };
    });

    afterEach(sandbox.restore);

    describe('paymentIntentSucceeded()', () => {
      it('returns if no order is found', async () => {
        sandbox.stub(common, 'createChargeTransactions').throws();
        set(event, 'data.object.id', 'pi_notfound');
        await webhook.paymentIntentSucceeded(event);
        await order.reload();

        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        sinon.assert.notCalled(common.createChargeTransactions);
      });

      it('create transactions, send notifications, and updates the order', async () => {
        sandbox.stub(common, 'createChargeTransactions').resolves();
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        await webhook.paymentIntentSucceeded(event);

        sinon.assert.calledOnceWithMatch(common.createChargeTransactions, event.data.object.charges.data[0], {
          order: {
            dataValues: { id: order.id },
          },
        });
        sinon.assert.calledOnceWithMatch(libPayments.sendEmailNotifications, {
          dataValues: { id: order.id },
        });

        await order.reload();
        expect(order.status).to.equal(OrderStatuses.PAID);
        expect(order.processedAt).to.not.be.null;
      });
    });

    describe('paymentIntentProcessing()', () => {
      it('returns if no order is found', async () => {
        set(event, 'data.object.id', 'pi_notfound');
        await webhook.paymentIntentProcessing(event);
        await order.reload();

        sandbox.stub(order, 'update').throws();

        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        expect(order.data.paymentIntent).to.have.property('id').not.equal('pi_notfound');
        sinon.assert.notCalled(order.update);
      });

      it('updates order.data.paymentIntent', async () => {
        await webhook.paymentIntentProcessing(event);
        await order.reload();
        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        expect(order.data.paymentIntent.charges).to.not.be.null;
      });
    });

    describe('paymentIntentFailed()', () => {
      it('returns if no order is found', async () => {
        set(event, 'data.object.id', 'pi_notfound');
        await webhook.paymentIntentFailed(event);
        await order.reload();

        sandbox.stub(order, 'update').throws();

        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        expect(order.data.paymentIntent).to.have.property('id').not.equal('pi_notfound');
        sinon.assert.notCalled(order.update);
      });

      it('send email notification and updates order.status', async () => {
        sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
        set(event, 'data.object.last_payment_error', {
          message: "You invested all your money on FTX and now you don't have anything left",
        });

        await webhook.paymentIntentFailed(event);
        await order.reload();

        expect(order.status).to.equal(OrderStatuses.ERROR);
        expect(order.data.paymentIntent.charges).to.not.be.null;
        sinon.assert.calledOnceWithMatch(
          libPayments.sendOrderFailedEmail,
          {
            dataValues: { id: order.id },
          },
          "You invested all your money on FTX and now you don't have anything left",
        );
      });
    });
  });
});
