/* eslint-disable camelcase */

import { fork } from 'child_process';
import path from 'path';

import * as Sentry from '@sentry/node';
import { expect } from 'chai';
import config from 'config';
import { set } from 'lodash';
import { QueryTypes } from 'sequelize';
import sinon, { assert, createSandbox } from 'sinon';
import Stripe from 'stripe';

import ActivityTypes from '../../../../server/constants/activities';
import { Service } from '../../../../server/constants/connected-account';
import ExpenseStatuses from '../../../../server/constants/expense-status';
import FEATURE from '../../../../server/constants/feature';
import OrderStatuses from '../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import * as applyContributionAccountingCategoryRules from '../../../../server/lib/accounting/categorization/contribution-rules';
import * as libPayments from '../../../../server/lib/payments';
import { MAX_RETRIES, processOrderWithSubscription } from '../../../../server/lib/recurring-contributions';
import * as redisLib from '../../../../server/lib/redis';
import stripe from '../../../../server/lib/stripe';
import * as transactions from '../../../../server/lib/transactions';
import models, { Collective, Expense, sequelize } from '../../../../server/models';
import { PayoutMethodTypes } from '../../../../server/models/PayoutMethod';
import * as common from '../../../../server/paymentProviders/stripe/common';
import * as webhook from '../../../../server/paymentProviders/stripe/webhook';
import stripeMocks from '../../../mocks/stripe';
import {
  fakeActiveHost,
  fakeCollective,
  fakeConnectedAccount,
  fakeExpense,
  fakeOrder,
  fakePaymentMethod,
  fakePayoutMethod,
  fakeSubscription,
  fakeTransaction,
  fakeUser,
  randStr,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('webhook', () => {
  let sandbox, metricsCountStub;

  beforeEach(async () => {
    await utils.resetTestDB();
    await utils.seedDefaultVendors();
    sandbox = createSandbox();
    sandbox.stub(config, 'sentry').value({ dsn: 'https://sentry.io/123' });
    metricsCountStub = sandbox.stub(Sentry.metrics, 'count');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('webhook()', () => {
    for (const body of [undefined, null, {}, 'not-json', { livemode: true }, { type: 123, livemode: true }]) {
      it(`rejects requests with an invalid body (${JSON.stringify(body)})`, async () => {
        let error: Error | undefined;
        try {
          await webhook.webhook({ body, headers: {} } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
        } catch (e) {
          error = e;
        }
        expect(error).to.exist;
        expect(error.message).to.equal('Source of event not recognized');
      });
    }
  });

  describe('chargeDisputeCreated()', () => {
    let order, user;

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
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
          data: {
            charge: { id: (stripeMocks.webhook_dispute_created.data.object as Stripe.Dispute).charge } as Stripe.Charge,
          },
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

      await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
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

    beforeEach(async () => {
      const collective = await fakeCollective({ hasMoneyManagement: true });
      paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
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
          kind: TransactionKind.CONTRIBUTION,
          data: {
            charge: { id: (stripeMocks.webhook_dispute_created.data.object as Stripe.Dispute).charge } as Stripe.Charge,
          },
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
        await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
        await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won);

        const transactions = await order.getTransactions();
        expect(transactions.map(tx => tx.isDisputed)).to.not.include(true);
      });

      describe('when the Order has a Subscription', () => {
        it('leave Order as CANCELLED', async () => {
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });

        it('does not reactivates the Subscription', async () => {
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won);

          const subscription = await order.getSubscription();
          expect(subscription.isActive).to.eql(false);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('resets the Order connected to the charge to PAID', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won);

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
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won);

          await user.reload();
          expect(user.data.features[FEATURE.ORDER]).to.eq(false);
        });
      });

      describe('when the User does not have other disputed Orders', () => {
        it('removes the Order limit from the User', async () => {
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_won);

          await user.reload();
          expect(user.data.features[FEATURE.ORDER]).to.eq(true);
        });
      });
    });

    describe('the dispute was lost and is fraud', () => {
      it('creates a refund transaction for the fraudulent transaction', async () => {
        await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
        await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });

      describe('when the Order has a Subscription', () => {
        it('resets the Order connected to the charge to CANCELLED', async () => {
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('resets the Order connected to the charge to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
          await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });
    });

    it('creates a dispute fee DEBIT transaction for the host collective whenever a fee is charged', async () => {
      await webhook.chargeDisputeCreated(stripeMocks.webhook_dispute_created);
      await webhook.chargeDisputeClosed(stripeMocks.webhook_dispute_lost);

      const transactions = await order.getTransactions();
      const disputeFeeTransaction = transactions.find(
        tx => tx.kind === 'PAYMENT_PROCESSOR_DISPUTE_FEE' && tx.type === 'DEBIT',
      );
      expect(disputeFeeTransaction.amount).to.eql(-1500);
    });
  });

  describe('reviewOpened()', () => {
    let order, user;

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
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
          data: {
            charge: {
              payment_intent: (stripeMocks.webhook_review_opened.data.object as Stripe.Review).payment_intent,
            } as Stripe.Charge,
          },
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

      await webhook.reviewOpened(stripeMocks.webhook_review_opened);
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
    let order, user, chargeTransaction;

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
      });
      user = await fakeUser();
      order = await fakeOrder(
        {
          CreatedByUserId: user.id,
          totalAmount: 10,
          PaymentMethodId: paymentMethod.id,
        },
        { withSubscription: true },
      );
      chargeTransaction = await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          amount: 10,
          data: {
            charge: {
              payment_intent: (stripeMocks.webhook_review_opened.data.object as Stripe.Review).payment_intent,
            } as Stripe.Charge,
          },
        },
        { createDoubleEntry: true },
      );
      await fakeTransaction(
        {
          CreatedByUserId: user.id,
          OrderId: order.id,
          TransactionGroup: chargeTransaction.TransactionGroup,
          amount: 5,
        },
        { createDoubleEntry: true },
      );
    });

    describe('when review is "approved"', () => {
      it('updates isInReview status of all Transactions connected to the charge', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_approved);

        const transactions = await order.getTransactions();
        expect(transactions.map(tx => tx.isInReview)).to.eql([false, false, false, false]);
      });

      describe('when the Order has a Subscription', () => {
        it('reactivates the Subscription connected to the charge', async () => {
          await webhook.reviewOpened(stripeMocks.webhook_review_opened);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_approved);

          const subscription = await order.getSubscription();
          expect(subscription.isActive).to.eql(true);
        });

        it('changes Order status back to ACTIVE', async () => {
          await webhook.reviewOpened(stripeMocks.webhook_review_opened);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_approved);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.ACTIVE);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to PAID', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.reviewOpened(stripeMocks.webhook_review_opened);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_approved);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.PAID);
        });
      });
    });

    describe('when review is "refunded_as_fraud"', () => {
      describe('when the Order has a Subscription', () => {
        it('changes Order status to CANCELLED', async () => {
          await webhook.reviewOpened(stripeMocks.webhook_review_opened);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded_as_fraud);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.reviewOpened(stripeMocks.webhook_review_opened);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded_as_fraud);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });

      it('limits Orders for User account', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded_as_fraud);

        await user.reload();
        expect(user.data.features[FEATURE.ORDER]).to.eq(false);
      });

      it('creates a refund transaction for the fraudulent transaction', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded_as_fraud);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });
    });

    describe('when review is "refunded"', () => {
      describe('when the Order has a Subscription', () => {
        it('changes Order status to CANCELLED', async () => {
          await webhook.reviewOpened(stripeMocks.webhook_review_opened);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.CANCELLED);
        });
      });

      describe('when the Order does not have a Subscription', () => {
        it('changes Order status back to REFUNDED', async () => {
          await order.update({ SubscriptionId: null });
          await webhook.reviewOpened(stripeMocks.webhook_review_opened);
          await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded);

          await order.reload();
          expect(order.status).to.eql(OrderStatuses.REFUNDED);
        });
      });

      it('does not limit Orders for User account', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded);

        await user.reload();
        expect(user.data).to.eq(null);
      });

      it('creates a refund transaction for the fraudulent transaction', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded);

        const transactions = await order.getTransactions();
        const refundTransactions = transactions.filter(tx => tx.isRefund === true);
        expect(refundTransactions.length).to.eql(2);
      });

      it('updates all related transactions to remove in review status', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened);
        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded);

        const transactions = await order.getTransactions();
        expect(transactions.every(tx => tx.isInReview === false)).to.eql(true);
      });

      it('does not refund again when the charge was already refunded in Open Collective', async () => {
        await webhook.reviewOpened(stripeMocks.webhook_review_opened);
        // Refund through Open Collective first: refund transactions copy `data.charge` from the original
        await libPayments.createRefundTransaction(chargeTransaction, 0, { ...chargeTransaction.data }, null);

        await webhook.reviewClosed(stripeMocks.webhook_review_closed_refunded);

        const transactions = await order.getTransactions();
        expect(transactions.filter(tx => tx.isRefund)).to.have.length(2);
        expect(transactions.every(tx => tx.isInReview === false)).to.eql(true);
        const activity = await models.Activity.findOne({
          where: { type: ActivityTypes.ORDER_REVIEW_CLOSED, OrderId: order.id },
        });
        expect(activity).to.exist;
      });
    });
  });

  describe('paymentIntent', () => {
    let order, event;

    beforeEach(async () => {
      const paymentMethod = await fakePaymentMethod({
        type: PAYMENT_METHOD_TYPE.PAYMENT_INTENT,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
      });
      order = await fakeOrder({
        PaymentMethodId: paymentMethod.id,
        FromCollectiveId: paymentMethod.CollectiveId,
        status: OrderStatuses.PROCESSING,
        totalAmount: 100e2,
        description: 'Do you even donate, brah?!',
        data: { stripePaymentIntent: { id: randStr('pi_fake') } },
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
            id: order.data.stripePaymentIntent.id,
            amount: 100e2,
            currency: 'usd',
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

    describe('stripePaymentIntentSucceeded()', () => {
      it('returns if no order is found', async () => {
        sandbox.stub(common, 'createChargeTransactions').throws();
        set(event, 'data.object.id', 'pi_notfound');
        await webhook.stripePaymentIntentSucceeded(event);
        await order.reload();

        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        assert.notCalled(common.createChargeTransactions);
      });

      it('create transactions, send notifications, and updates the order', async () => {
        sandbox.stub(common, 'createChargeTransactions').resolves();
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        await webhook.stripePaymentIntentSucceeded(event);

        assert.calledOnceWithMatch(common.createChargeTransactions, event.data.object.charges.data[0], {
          order: {
            dataValues: { id: order.id },
          },
        });
        assert.calledOnceWithMatch(libPayments.sendEmailNotifications, {
          dataValues: { id: order.id },
        });

        await order.reload();
        expect(order.status).to.equal(OrderStatuses.PAID);
        expect(order.processedAt).to.not.be.null;
      });

      it('records a thirdparty payment outcome metric for the successful payment', async () => {
        sandbox.stub(common, 'createChargeTransactions').resolves();
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        await webhook.stripePaymentIntentSucceeded(event);

        expect(metricsCountStub).to.have.been.calledOnce;
        expect(metricsCountStub.firstCall.args).to.deep.equal([
          'thirdparty.stripe.payment.succeeded',
          1,
          { attributes: { flow: 'contribution', method: 'paymentintent' } },
        ]);
      });

      it('does not process the order when PaymentIntent amount does not match', async () => {
        sandbox.stub(common, 'createChargeTransactions').throws();
        set(event, 'data.object.amount', 50e2);
        await webhook.stripePaymentIntentSucceeded(event);

        await order.reload();
        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        assert.notCalled(common.createChargeTransactions);
      });

      it('does not process the order when PaymentIntent currency does not match', async () => {
        sandbox.stub(common, 'createChargeTransactions').throws();
        set(event, 'data.object.currency', 'eur');
        await webhook.stripePaymentIntentSucceeded(event);

        await order.reload();
        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        assert.notCalled(common.createChargeTransactions);
      });

      it('calls applyContributionAccountingCategoryRules after processing stripe order', async () => {
        const applyContributionAccountingCategoryRulesSpy = sandbox.spy(
          applyContributionAccountingCategoryRules,
          'applyContributionAccountingCategoryRules',
        );
        sandbox.stub(common, 'createChargeTransactions').resolves();
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        await webhook.stripePaymentIntentSucceeded(event);

        assert.calledOnceWithMatch(common.createChargeTransactions, event.data.object.charges.data[0], {
          order: {
            dataValues: { id: order.id },
          },
        });
        assert.calledOnceWithMatch(libPayments.sendEmailNotifications, {
          dataValues: { id: order.id },
        });

        await order.reload();
        expect(order.status).to.equal(OrderStatuses.PAID);
        expect(order.processedAt).to.not.be.null;
        expect(applyContributionAccountingCategoryRulesSpy.calledWithMatch({ id: order.id })).to.be.true;
      });

      it('calls applyContributionAccountingCategoryRules after processing initial subscription order', async () => {
        const applyContributionAccountingCategoryRulesSpy = sandbox.spy(
          applyContributionAccountingCategoryRules,
          'applyContributionAccountingCategoryRules',
        );
        sandbox.stub(common, 'createChargeTransactions').resolves(
          fakeTransaction(
            {
              OrderId: order.id,
              amount: 100e2,
              currency: order.currency,
              type: 'CREDIT',
            },
            {
              createDoubleEntry: true,
            },
          ),
        );
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        await order.update({ interval: 'month', SubscriptionId: null });
        await webhook.stripePaymentIntentSucceeded(event);

        assert.calledOnceWithMatch(common.createChargeTransactions, event.data.object.charges.data[0], {
          order: {
            dataValues: { id: order.id },
          },
        });
        assert.calledOnceWithMatch(libPayments.sendEmailNotifications, {
          dataValues: { id: order.id },
        });

        await order.reload();
        expect(order.status).to.equal(OrderStatuses.ACTIVE);
        expect(order.processedAt).to.not.be.null;
        expect(applyContributionAccountingCategoryRulesSpy.calledWithMatch({ id: order.id })).to.be.true;
      });

      it('does not calls applyContributionAccountingCategoryRules on recurring order', async () => {
        const applyContributionAccountingCategoryRulesSpy = sandbox.spy(
          applyContributionAccountingCategoryRules,
          'applyContributionAccountingCategoryRules',
        );
        sandbox.stub(common, 'createChargeTransactions').resolves(
          fakeTransaction(
            {
              OrderId: order.id,
              amount: 100e2,
              currency: order.currency,
              type: 'CREDIT',
            },
            {
              createDoubleEntry: true,
            },
          ),
        );
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        const subscription = await fakeSubscription({
          CollectiveId: order.collective.id,
          interval: 'month',
          isActive: true,
        });
        await order.update({ interval: 'month', SubscriptionId: subscription.id });
        await webhook.stripePaymentIntentSucceeded(event);

        assert.calledOnceWithMatch(common.createChargeTransactions, event.data.object.charges.data[0], {
          order: {
            dataValues: { id: order.id },
          },
        });
        assert.calledOnceWithMatch(libPayments.sendEmailNotifications, {
          dataValues: { id: order.id },
        });

        await order.reload();
        expect(order.status).to.equal(OrderStatuses.ACTIVE);
        expect(order.processedAt).to.not.be.null;
        expect(applyContributionAccountingCategoryRulesSpy).to.not.have.been.called;
      });

      it('updates chargeNumber, resets chargeRetryCount, and bumps next dates on recurring success', async () => {
        sandbox.stub(common, 'createChargeTransactions').resolves(
          fakeTransaction(
            {
              OrderId: order.id,
              amount: 100e2,
              currency: order.currency,
              type: 'CREDIT',
            },
            { createDoubleEntry: true },
          ),
        );
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        const subscription = await fakeSubscription({
          CollectiveId: order.collective.id,
          interval: 'month',
          isActive: true,
          chargeNumber: 2,
          chargeRetryCount: 3, // had been failing before this success
          nextPeriodStart: new Date('2026-03-15 0:0'),
          nextChargeDate: new Date('2026-03-20 0:0'),
        });
        await order.update({ interval: 'month', SubscriptionId: subscription.id });

        await webhook.stripePaymentIntentSucceeded(event);

        await subscription.reload();
        // chargeNumber is incremented to record the successful attempt
        expect(subscription.chargeNumber).to.equal(3);
        // chargeRetryCount resets to 0 because we recovered from previous failures
        expect(subscription.chargeRetryCount).to.equal(0);
        // both date fields are advanced one month from nextPeriodStart
        expect(subscription.nextPeriodStart.getTime()).to.equal(new Date('2026-04-15 0:0').getTime());
        expect(subscription.nextChargeDate.getTime()).to.equal(new Date('2026-04-15 0:0').getTime());
        expect(subscription.lastChargedAt).to.not.be.null;
      });

      it('ignores a redelivered succeeded event when the charge was already recorded', async () => {
        const chargeId = randStr('ch_fake');
        set(event, 'data.object.charges.data[0].id', chargeId);
        // Simulate a previous delivery that already recorded the transaction for this charge
        await fakeTransaction({ OrderId: order.id, data: { charge: { id: chargeId } as Stripe.Charge } });

        const createChargeTransactionsStub = sandbox.stub(common, 'createChargeTransactions').resolves();
        const sendEmailNotificationsStub = sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        const subscription = await fakeSubscription({
          CollectiveId: order.collective.id,
          interval: 'month',
          isActive: true,
          chargeNumber: 2,
        });
        await order.update({ interval: 'month', SubscriptionId: subscription.id });

        await webhook.stripePaymentIntentSucceeded(event);

        // The existing-charge dedup short-circuits the handler before any side effect
        assert.notCalled(createChargeTransactionsStub);
        assert.notCalled(sendEmailNotificationsStub);
        expect(metricsCountStub.called).to.be.false;
        await subscription.reload();
        expect(subscription.chargeNumber).to.equal(2);
      });

      it('passes firstPayment: false when paying a subscription that already has a SubscriptionId', async () => {
        sandbox
          .stub(common, 'createChargeTransactions')
          .resolves(
            fakeTransaction(
              { OrderId: order.id, amount: 100e2, currency: order.currency, type: 'CREDIT' },
              { createDoubleEntry: true },
            ),
          );
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        const subscription = await fakeSubscription({
          CollectiveId: order.collective.id,
          interval: 'month',
          isActive: true,
        });
        await order.update({ interval: 'month', SubscriptionId: subscription.id });

        await webhook.stripePaymentIntentSucceeded(event);

        // Recurring charges (subscription already exists) should never display the "first payment" copy.
        assert.calledOnceWithMatch(
          libPayments.sendEmailNotifications,
          sinon.match(v => v.id === order.id),
          sinon.match.any,
          {
            firstPayment: false,
          },
        );
      });

      it('passes firstPayment: true on the initial subscription charge (no SubscriptionId yet)', async () => {
        sandbox
          .stub(common, 'createChargeTransactions')
          .resolves(
            fakeTransaction(
              { OrderId: order.id, amount: 100e2, currency: order.currency, type: 'CREDIT' },
              { createDoubleEntry: true },
            ),
          );
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        await order.update({ interval: 'month', SubscriptionId: null });

        await webhook.stripePaymentIntentSucceeded(event);

        // First-time async confirmation of a recurring contribution should mark the email as a first payment.
        assert.calledOnceWithMatch(
          libPayments.sendEmailNotifications,
          sinon.match(v => v.id === order.id),
          sinon.match.any,
          {
            firstPayment: true,
          },
        );
      });

      describe('when the order was cancelled while the async charge was in-flight', () => {
        it('records the transaction and creates the membership but keeps the order CANCELLED', async () => {
          sandbox
            .stub(common, 'createChargeTransactions')
            .resolves(
              fakeTransaction(
                { OrderId: order.id, amount: 100e2, currency: order.currency, type: 'CREDIT' },
                { createDoubleEntry: true },
              ),
            );
          sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
          const getOrCreateMembersSpy = sandbox.spy(models.Order.prototype, 'getOrCreateMembers');

          // User cancelled while the async charge was still being confirmed
          await order.update({
            status: OrderStatuses.CANCELLED,
          });

          await webhook.stripePaymentIntentSucceeded(event);

          assert.calledOnce(common.createChargeTransactions);
          await order.reload();
          expect(order.status).to.equal(OrderStatuses.CANCELLED);
          expect(getOrCreateMembersSpy).to.have.been.called;
        });

        it('records the charge but keeps a recurring order CANCELLED without reactivating the subscription', async () => {
          sandbox
            .stub(common, 'createChargeTransactions')
            .resolves(
              fakeTransaction(
                { OrderId: order.id, amount: 100e2, currency: order.currency, type: 'CREDIT' },
                { createDoubleEntry: true },
              ),
            );
          sandbox.stub(libPayments, 'sendEmailNotifications').resolves();

          const subscription = await fakeSubscription({
            CollectiveId: order.collective.id,
            interval: 'month',
            isActive: false, // cancellation deactivated the subscription
            lastChargedAt: null,
          });
          await order.update({
            interval: 'month',
            SubscriptionId: subscription.id,
            status: OrderStatuses.CANCELLED,
          });

          await webhook.stripePaymentIntentSucceeded(event);

          await order.reload();
          await subscription.reload();

          expect(order.status).to.equal(OrderStatuses.CANCELLED);
          expect(subscription.isActive).to.be.false;
          expect(subscription.lastChargedAt).to.not.be.null;
        });
      });
    });

    describe('paymentIntentProcessing()', () => {
      it('returns if no order is found', async () => {
        set(event, 'data.object.id', 'pi_notfound');
        await webhook.stripePaymentIntentProcessing(event);
        await order.reload();

        sandbox.stub(order, 'update').throws();

        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        expect(order.data.stripePaymentIntent).to.have.property('id').not.equal('pi_notfound');
        assert.notCalled(order.update);
      });

      it('updates order.data.stripePaymentIntent', async () => {
        sandbox.stub(stripe.paymentMethods, 'retrieve').resolves({
          type: 'us_bank_account',
          us_bank_account: {
            name: 'Test Bank',
            last4: '1234',
          },
        });

        await webhook.stripePaymentIntentProcessing(event);
        await order.reload();
        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        expect(order.data.stripePaymentIntent.charges).to.not.be.null;

        const paymentMethod = await order.getPaymentMethod();
        expect(paymentMethod.service).to.equal(PAYMENT_METHOD_SERVICE.STRIPE);
        expect(paymentMethod.type).to.equal(PAYMENT_METHOD_TYPE.US_BANK_ACCOUNT);
      });

      it('stores proper card info in payment method', async () => {
        sandbox.stub(stripe.paymentMethods, 'retrieve').resolves({
          type: 'card',
          id: 'pm_123456789abcdef123456789',
          card: {
            brand: 'Visa',
            last4: '1234',
            country: 'US',
            exp_year: 2024,
            exp_month: 12,
          },
        });

        await webhook.stripePaymentIntentProcessing(event);
        await order.reload();
        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        expect(order.data.stripePaymentIntent.charges).to.not.be.null;

        const paymentMethod = await order.getPaymentMethod();
        expect(paymentMethod.service).to.equal(PAYMENT_METHOD_SERVICE.STRIPE);
        expect(paymentMethod.type).to.equal(PAYMENT_METHOD_TYPE.CREDITCARD);
        expect(paymentMethod.data).to.deep.eq({
          brand: 'Visa',
          country: 'US',
          expYear: 2024,
          expMonth: 12,
          stripeAccount: 'acct_15vekcDjPFcHOcTm',
          stripePaymentMethodId: 'pm_123456789abcdef123456789',
        });
        expect(paymentMethod.name).to.equal('1234');
        expect(paymentMethod.expiryDate).to.not.be.null;
        expect(paymentMethod.expiryDate.getFullYear()).to.equal(2024);
        expect(paymentMethod.expiryDate.getMonth()).to.equal(11);
        expect(paymentMethod.expiryDate.getDate()).to.equal(31);
      });
    });

    describe('paymentIntentFailed()', () => {
      it('returns if no order is found', async () => {
        set(event, 'data.object.id', 'pi_notfound');
        await webhook.stripePaymentIntentFailed(event);
        await order.reload();

        sandbox.stub(order, 'update').throws();

        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        expect(order.data.stripePaymentIntent).to.have.property('id').not.equal('pi_notfound');
        assert.notCalled(order.update);
        expect(metricsCountStub.called).to.be.false;
      });

      it('send email notification and updates order.status', async () => {
        sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
        set(event, 'data.object.last_payment_error', {
          message: "You invested all your money on FTX and now you don't have anything left",
        });

        await webhook.stripePaymentIntentFailed(event);
        await order.reload();

        expect(order.status).to.equal(OrderStatuses.ERROR);
        expect(order.data.stripePaymentIntent.charges).to.not.be.null;
        assert.calledOnceWithMatch(
          libPayments.sendOrderFailedEmail,
          {
            dataValues: { id: order.id },
          },
          'Something went wrong with the payment, please contact support@opencollective.com.',
        );
      });

      it('records a thirdparty payment outcome metric for the failed payment', async () => {
        sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
        set(event, 'data.object.last_payment_error', {
          code: 'insufficient_funds',
          message: 'Your card has insufficient funds.',
        });

        await webhook.stripePaymentIntentFailed(event);

        expect(metricsCountStub).to.have.been.calledOnce;
        expect(metricsCountStub.firstCall.args).to.deep.equal([
          'thirdparty.stripe.payment.failed',
          1,
          { attributes: { flow: 'contribution', method: 'paymentintent', error_type: 'insufficient_funds' } },
        ]);
      });

      it('does not record the metric again when the failure event is redelivered', async () => {
        sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
        set(event, 'data.object.last_payment_error', {
          code: 'card_declined',
          message: 'Your card was declined.',
        });

        await webhook.stripePaymentIntentFailed(event);
        await webhook.stripePaymentIntentFailed(event);

        expect(metricsCountStub).to.have.been.calledOnce;
      });

      describe('when the order has a subscription', () => {
        for (const lateProviderResponse of [false, 'succeeded', 'processing']) {
          it(`preserves a successful payment against an older failure (late provider response: ${lateProviderResponse})`, async () => {
            const sendFailureEmail = sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
            const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 0 });
            await order.update({ interval: 'month', SubscriptionId: subscription.id });
            const failedIntent = {
              ...event.data.object,
              status: 'requires_payment_method',
              charges: { data: [{ ...event.data.object.charges.data[0], id: randStr('ch_declined'), paid: false }] },
            };
            const failure = { ...event, id: 'evt_prior_failure', data: { object: failedIntent } };
            await webhook.stripePaymentIntentFailed(failure);
            await order.reload();
            const providerData = { ...order.data };
            const succeededIntent = {
              ...failedIntent,
              status: 'succeeded',
              charges: {
                data: [
                  {
                    ...failedIntent.charges.data[0],
                    id: randStr('ch_paid'),
                    paid: true,
                    status: 'succeeded',
                    payment_intent: failedIntent.id,
                  },
                ],
              },
            };
            sandbox.stub(common, 'createChargeTransactions').callsFake(async charge =>
              fakeTransaction(
                {
                  OrderId: order.id,
                  CollectiveId: order.CollectiveId,
                  FromCollectiveId: order.FromCollectiveId,
                  amount: order.totalAmount,
                  currency: order.currency,
                  type: 'CREDIT',
                  kind: TransactionKind.CONTRIBUTION,
                  isRefund: false,
                  data: { charge },
                },
                { createDoubleEntry: true },
              ),
            );
            await webhook.stripePaymentIntentSucceeded({ ...event, data: { object: succeededIntent } });
            await order.reload();
            expect(order.status).to.equal(OrderStatuses.ACTIVE);
            expect(order.data.stripePaymentIntent).to.be.undefined;
            if (lateProviderResponse) {
              // processRecurringOrder persists its confirmation response using its pre-webhook snapshot.
              await order.update({
                data: { ...providerData, stripePaymentIntent: { ...succeededIntent, status: lateProviderResponse } },
              });
            }
            await subscription.reload();
            const beforeOrder = order.toJSON();
            const beforeSubscription = subscription.toJSON();
            metricsCountStub.resetHistory();
            await webhook.stripePaymentIntentFailed(failure);
            await order.reload();
            await subscription.reload();
            expect(order.status).to.equal(OrderStatuses.ACTIVE);
            expect(order.data).to.eql(beforeOrder.data);
            expect(order.toJSON()).to.eql(beforeOrder);
            expect(subscription.toJSON()).to.eql(beforeSubscription);
            expect(metricsCountStub).to.not.have.been.called;
            expect(sendFailureEmail.callCount).to.equal(lateProviderResponse ? 2 : 1);
          });
        }

        it('does not confuse a paid previous intent with the currently failing intent', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 1 });
          await order.update({ interval: 'month', SubscriptionId: subscription.id });
          await fakeTransaction({
            OrderId: order.id,
            kind: TransactionKind.CONTRIBUTION,
            type: 'CREDIT',
            isRefund: false,
            data: { charge: { id: randStr('ch_old'), payment_intent: randStr('pi_old'), paid: true } as Stripe.Charge },
          });
          await webhook.stripePaymentIntentFailed(event);
          await order.reload();
          await subscription.reload();
          expect(order.status).to.equal(OrderStatuses.ERROR);
          expect(subscription.chargeRetryCount).to.equal(2);
          expect(metricsCountStub).to.have.been.calledOnce;
        });

        for (const previousFailureRecorded of [true, false]) {
          it(`attributes the previous intent failure while a resumed order starts a new attempt (recorded: ${previousFailureRecorded})`, async () => {
            sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 0 });
            await order.update({ interval: 'month', SubscriptionId: subscription.id, status: OrderStatuses.ACTIVE });
            order.Subscription = subscription;
            const priorIntent = { ...event.data.object, id: randStr('pi_prior'), status: 'processing' };
            const processPayment = sandbox.stub(libPayments, 'processOrder').callsFake(async processingOrder => {
              await processingOrder.update({ data: { ...processingOrder.data, stripePaymentIntent: priorIntent } });
            });
            await processOrderWithSubscription(order, {});
            const priorFailure = { ...event, data: { object: { ...priorIntent, status: 'requires_payment_method' } } };
            if (previousFailureRecorded) {
              await webhook.stripePaymentIntentFailed(priorFailure);
            }
            await order.reload();
            await order.update({ status: OrderStatuses.PAUSED });
            await subscription.reload();
            await subscription.update({ isActive: false });
            order.Subscription = subscription;
            await libPayments.resumeOrderInDb(order, 'Resume contribution');
            expect(order.status).to.equal(OrderStatuses.ACTIVE);
            const nextIntent = { ...event.data.object, id: randStr('pi_resumed') };
            let previousFailureCount: number;
            metricsCountStub.resetHistory();
            processPayment.callsFake(async processingOrder => {
              await webhook.stripePaymentIntentFailed(priorFailure);
              await subscription.reload();
              previousFailureCount = subscription.chargeRetryCount;
              await processingOrder.update({ data: { ...processingOrder.data, stripePaymentIntent: nextIntent } });
            });
            await processOrderWithSubscription(order, {});
            expect(previousFailureCount).to.equal(1);
            await webhook.stripePaymentIntentFailed({ ...event, data: { object: nextIntent } });
            await subscription.reload();
            expect(subscription.chargeRetryCount).to.equal(2);
            expect(metricsCountStub.callCount).to.equal(previousFailureRecorded ? 1 : 2);
          });
        }

        const startWorker = () => {
          const child = fork(path.join(__dirname, '../../../test-helpers/stripe-failure-worker.ts'), [], {
            execArgv: ['--require', './test/setup-babel.cjs', '--require', './test/setup-env.cjs'],
            silent: true,
          });
          child.stdout.resume();
          child.stderr.resume();
          const messages: { type: string; pid?: number; error?: string }[] = [];
          let workerError: Error;
          child.on('message', message => {
            if (typeof message === 'object' && message !== null && 'type' in message) {
              messages.push({
                type: String(message.type),
                pid: 'pid' in message ? Number(message.pid) : undefined,
                error: 'error' in message ? String(message.error) : undefined,
              });
            }
          });
          child.on('error', error => {
            workerError = error;
          });
          child.on('exit', code => {
            if (code !== 0) {
              workerError = new Error(`Stripe test worker exited with code ${code}`);
            }
          });
          const waitFor = type =>
            utils.waitForCondition(
              () => {
                const error = messages.find(message => message.type === 'error');
                if (workerError || error) {
                  throw workerError || new Error(error.error);
                }
                return messages.find(message => message.type === type);
              },
              { timeout: 30000 },
            );
          return { child, waitFor };
        };
        for (const terminateFirst of [false, true]) {
          it(`recovers duplicate failures across independent processes (crashed worker: ${terminateFirst})`, async () => {
            const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 0 });
            await order.update({ interval: 'month', SubscriptionId: subscription.id });
            const first = startWorker();
            const second = startWorker();
            try {
              await Promise.all([first.waitFor('ready'), second.waitFor('ready')]);
              expect(first.child.pid).to.not.equal(second.child.pid);
              first.child.send({ type: 'run', event: { ...event, id: 'evt_worker_a' }, pause: true });
              await first.waitFor('paused');
              second.child.send({ type: 'run', event: { ...event, id: 'evt_worker_b' }, pause: false });
              const { pid } = await second.waitFor('backend');
              await utils.waitForCondition(async () => {
                const [activity] = await sequelize.query<{ wait_event_type: string }>(
                  'SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid',
                  { replacements: { pid }, type: QueryTypes.SELECT },
                );
                return activity?.wait_event_type === 'Lock';
              });
              if (terminateFirst) {
                const exited = Promise.withResolvers<void>();
                first.child.once('exit', () => exited.resolve());
                first.child.kill('SIGKILL');
                await exited.promise;
                await second.waitFor('done');
              } else {
                first.child.send({ type: 'release' });
                await Promise.all([first.waitFor('done'), second.waitFor('done')]);
              }
              await subscription.reload();
              await order.reload();
              expect(subscription.chargeRetryCount).to.equal(1);
              expect(subscription.isActive).to.equal(true);
              expect(order.status).to.equal(OrderStatuses.ERROR);
            } finally {
              first.child.kill();
              second.child.kill();
            }
          }).timeout(90000);
        }

        for (const { initialCount, crashWorker } of [
          { initialCount: 1, crashWorker: false },
          { initialCount: MAX_RETRIES - 1, crashWorker: false },
          { initialCount: 1, crashWorker: true },
        ]) {
          it(`keeps the outcome from an early failure in another worker with ${initialCount} retries (crash: ${crashWorker})`, async () => {
            sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            const subscription = await fakeSubscription({
              interval: 'month',
              isActive: true,
              chargeRetryCount: initialCount,
            });
            await order.update({ interval: 'month', SubscriptionId: subscription.id, status: OrderStatuses.ERROR });
            order.Subscription = subscription;
            const intent = { ...event.data.object, id: randStr('pi_worker_retry'), status: 'requires_payment_method' };
            const failureEvent = { ...event, data: { object: intent } };
            sandbox.stub(libPayments, 'processOrder').callsFake(async processingOrder => {
              const processingIntent = { ...intent, status: 'processing' };
              await processingOrder.update({
                data: { ...processingOrder.data, stripePaymentIntent: processingIntent },
              });
              const worker = startWorker();
              try {
                await worker.waitFor('ready');
                worker.child.send({ type: 'run', event: failureEvent, pause: crashWorker });
                if (crashWorker) {
                  await worker.waitFor('paused');
                  const exited = Promise.withResolvers<void>();
                  worker.child.once('exit', () => exited.resolve());
                  worker.child.kill('SIGKILL');
                  await exited.promise;
                  const recovery = startWorker();
                  try {
                    await recovery.waitFor('ready');
                    recovery.child.send({ type: 'run', event: failureEvent, pause: false });
                    await recovery.waitFor('done');
                  } finally {
                    recovery.child.kill();
                  }
                } else {
                  await worker.waitFor('done');
                }
              } finally {
                worker.child.kill();
              }
              // BACS/SEPA confirmation can persist its earlier response after the webhook has committed.
              await processingOrder.update({
                status: OrderStatuses.PROCESSING,
                data: { ...processingOrder.data, stripePaymentIntent: processingIntent },
              });
            });
            const result = await processOrderWithSubscription(order, {});
            await subscription.reload();
            await order.reload();
            const atThreshold = initialCount + 1 >= MAX_RETRIES;
            expect(subscription.chargeRetryCount).to.equal(atThreshold ? initialCount : initialCount + 1);
            expect(subscription.isActive).to.equal(!atThreshold);
            expect(order.status).to.equal(atThreshold ? OrderStatuses.CANCELLED : OrderStatuses.ERROR);
            expect(result.status).to.equal('failure');
            expect(result.retriesAfter).to.equal(subscription.chargeRetryCount);
            const after = subscription.toJSON();
            await webhook.stripePaymentIntentFailed(failureEvent);
            await subscription.reload();
            expect(subscription.toJSON()).to.eql(after);
          }).timeout(60000);
        }

        for (const reusePaymentIntent of [false, true]) {
          it(`does not recount a synchronous exception after its early failure webhook (reuse intent: ${reusePaymentIntent})`, async () => {
            sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 1 });
            await order.update({ interval: 'month', SubscriptionId: subscription.id, status: OrderStatuses.ERROR });
            order.Subscription = subscription;
            if (!reusePaymentIntent) {
              event.data.object.id = randStr('pi_sync_retry');
            } else {
              // The card provider can reconfirm a matching failed intent instead of creating a new one.
              await order.paymentMethod.update({ type: PAYMENT_METHOD_TYPE.CREDITCARD });
              await order.update({ data: { ...order.data, stripePaymentIntent: event.data.object } });
            }
            sandbox.stub(libPayments, 'processOrder').callsFake(async processingOrder => {
              await processingOrder.update({
                data: { ...processingOrder.data, stripePaymentIntent: event.data.object },
              });
              await webhook.stripePaymentIntentFailed(event);
              throw new Error('Your card was declined.');
            });
            await processOrderWithSubscription(order, {});
            await webhook.stripePaymentIntentFailed(event);
            await subscription.reload();
            expect(subscription.chargeRetryCount).to.equal(2);
            expect(metricsCountStub).to.have.been.calledOnce;
          });
        }

        it('does not treat the previous intent failure as the newly started retry', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 1 });
          await order.update({ interval: 'month', SubscriptionId: subscription.id, status: OrderStatuses.ERROR });
          order.Subscription = subscription;
          const newIntent = { ...event.data.object, id: randStr('pi_next_retry') };
          sandbox.stub(libPayments, 'processOrder').callsFake(async processingOrder => {
            // The new processing invocation exists, but the provider has not yet persisted its new intent.
            await webhook.stripePaymentIntentFailed({ ...event, id: 'evt_old_attempt_again' });
            await subscription.reload();
            expect(subscription.chargeRetryCount).to.equal(1);
            await processingOrder.update({ data: { ...processingOrder.data, stripePaymentIntent: newIntent } });
          });
          await processOrderWithSubscription(order, {});
          const failure = { ...event, data: { object: newIntent } };
          await webhook.stripePaymentIntentFailed(failure);
          await webhook.stripePaymentIntentFailed({ ...failure, id: 'evt_new_attempt_again' });
          await subscription.reload();
          expect(subscription.chargeRetryCount).to.equal(2);
          expect(metricsCountStub).to.have.been.calledOnce;
        });

        it('records a terminal 3DS failure without recounting the confirmation retry', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          await order.paymentMethod.update({ type: PAYMENT_METHOD_TYPE.CREDITCARD });
          const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 1 });
          await order.update({ interval: 'month', SubscriptionId: subscription.id, status: OrderStatuses.ERROR });
          order.Subscription = subscription;
          const intent = { ...event.data.object, id: randStr('pi_confirmation'), status: 'requires_action' };
          sandbox.stub(libPayments, 'processOrder').callsFake(async processingOrder => {
            await processingOrder.update({ data: { ...processingOrder.data, stripePaymentIntent: intent } });
            const error = new Error('Payment Intent require action');
            error['stripeResponse'] = { paymentIntent: intent };
            throw error;
          });
          await processOrderWithSubscription(order, {});
          await subscription.reload();
          expect(subscription.chargeRetryCount).to.equal(2);
          expect(metricsCountStub).to.not.have.been.called;

          // A client confirmation can transition this same intent back to PROCESSING before it fails.
          await order.update({ status: OrderStatuses.PROCESSING });
          const failure = { ...event, data: { object: { ...intent, status: 'requires_payment_method' } } };
          await webhook.stripePaymentIntentFailed(failure);
          await webhook.stripePaymentIntentFailed(failure);
          await subscription.reload();
          expect(subscription.chargeRetryCount).to.equal(2);
          expect(metricsCountStub).to.have.been.calledOnce;
        });

        for (const initialStatus of [OrderStatuses.ACTIVE, OrderStatuses.ERROR]) {
          it(`counts a failure delivered before recurring processing finishes from ${initialStatus}`, async () => {
            sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            const initialCount = initialStatus === OrderStatuses.ERROR ? 1 : 0;
            const subscription = await fakeSubscription({
              interval: 'month',
              isActive: true,
              chargeRetryCount: initialCount,
            });
            await order.update({ interval: 'month', SubscriptionId: subscription.id, status: initialStatus });
            order.Subscription = subscription;
            // Recurring PaymentIntent payments create a new intent before confirmation.
            event.data.object.id = randStr('pi_early_retry');
            event.data.object.status = 'requires_payment_method';
            sandbox.stub(libPayments, 'processOrder').callsFake(async processingOrder => {
              // Stripe can deliver the failure after confirmation but before the cron worker saves PROCESSING.
              await processingOrder.update({
                data: { ...processingOrder.data, stripePaymentIntent: { ...event.data.object, status: 'processing' } },
              });
              await webhook.stripePaymentIntentFailed(event);
            });
            await processOrderWithSubscription(order, {});
            await webhook.stripePaymentIntentFailed(event);
            await subscription.reload();
            await order.reload();
            expect(subscription.chargeRetryCount).to.equal(initialCount + 1);
            expect(order.status).to.equal(OrderStatuses.ERROR);
          });
        }

        for (const distinctEventId of [false, true]) {
          it(`serializes concurrent failures in PostgreSQL without Redis (distinct event IDs: ${distinctEventId})`, async () => {
            sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            sandbox.stub(redisLib, 'createRedisClient').resolves(null);
            const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 0 });
            await order.update({ interval: 'month', SubscriptionId: subscription.id });
            const paused = Promise.withResolvers<void>();
            const release = Promise.withResolvers<void>();
            const secondPid = Promise.withResolvers<number>();
            const originalUpdate = models.Subscription.prototype.update;
            let firstUpdate = true;
            sandbox.stub(models.Subscription.prototype, 'update').callsFake(async function (...args) {
              const result = await originalUpdate.apply(this, args);
              if (firstUpdate) {
                firstUpdate = false;
                paused.resolve();
                await release.promise;
              }
              return result;
            });
            const first = webhook.stripePaymentIntentFailed({ ...event, id: 'evt_first' });
            let second: Promise<unknown>;
            try {
              await paused.promise;
              const originalFind = models.Order.findOne;
              sandbox.stub(models.Order, 'findOne').callsFake(async options => {
                const [backend] = await sequelize.query<{ pid: number }>('SELECT pg_backend_pid() AS pid', {
                  transaction: options.transaction,
                  type: QueryTypes.SELECT,
                });
                secondPid.resolve(backend.pid);
                return originalFind.call(models.Order, options);
              });
              second = webhook.stripePaymentIntentFailed({
                ...event,
                id: distinctEventId ? 'evt_second' : 'evt_first',
              });
              const pid = await secondPid.promise;
              // Observe the real second database connection blocked on a PostgreSQL lock, not a timing delay.
              await utils.waitForCondition(async () => {
                const [activity] = await sequelize.query<{ wait_event_type: string }>(
                  'SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid',
                  { replacements: { pid }, type: QueryTypes.SELECT },
                );
                return activity?.wait_event_type === 'Lock';
              });
            } finally {
              release.resolve();
              await Promise.allSettled([first, second]);
            }
            await first;
            await second;
            await subscription.reload();
            expect(subscription.chargeRetryCount).to.equal(1);
            expect(subscription.isActive).to.equal(true);
            expect(metricsCountStub).to.have.been.calledOnce;
          });
        }

        for (const failurePoint of ['before order update', 'after subscription update', 'before cancellation']) {
          it(`recovers atomically from an exception ${failurePoint}`, async () => {
            sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            const atThreshold = failurePoint === 'before cancellation';
            const initialCount = atThreshold ? MAX_RETRIES - 1 : 0;
            const subscription = await fakeSubscription({
              interval: 'month',
              isActive: true,
              chargeRetryCount: initialCount,
            });
            await order.update({ interval: 'month', SubscriptionId: subscription.id });
            const before = subscription.toJSON();
            const target = failurePoint === 'after subscription update' ? models.Subscription : models.Order;
            const originalUpdate = target.prototype.update;
            const update = sandbox.stub(target.prototype, 'update').callsFake(async function (values, options) {
              if (failurePoint === 'after subscription update') {
                await originalUpdate.call(this, values, options);
                throw new Error('injected failure');
              } else if (!atThreshold || values.status === OrderStatuses.CANCELLED) {
                throw new Error('injected failure');
              }
              return originalUpdate.call(this, values, options);
            });
            await expect(webhook.stripePaymentIntentFailed(event)).to.be.rejectedWith('injected failure');
            update.restore();
            await order.reload();
            await subscription.reload();
            expect(order.status).to.equal(OrderStatuses.PROCESSING);
            expect(subscription.toJSON()).to.eql(before);
            expect(metricsCountStub).to.not.have.been.called;

            await webhook.stripePaymentIntentFailed(event);
            await webhook.stripePaymentIntentFailed(event);
            await subscription.reload();
            await order.reload();
            expect(subscription.chargeRetryCount).to.equal(atThreshold ? initialCount : 1);
            expect(subscription.isActive).to.equal(!atThreshold);
            expect(order.status).to.equal(atThreshold ? OrderStatuses.CANCELLED : OrderStatuses.ERROR);
            expect(metricsCountStub).to.have.been.calledOnce;
          });
        }

        it('rolls back the order when updating the subscription fails and safely retries delivery', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          const subscription = await fakeSubscription({ interval: 'month', isActive: true, chargeRetryCount: 0 });
          await order.update({ interval: 'month', SubscriptionId: subscription.id });
          const update = sandbox
            .stub(models.Subscription.prototype, 'update')
            .rejects(new Error('temporary DB failure'));

          await expect(webhook.stripePaymentIntentFailed(event)).to.be.rejectedWith('temporary DB failure');
          update.restore();
          await order.reload();
          await subscription.reload();
          expect(order.status).to.equal(OrderStatuses.PROCESSING);
          expect(subscription.chargeRetryCount).to.equal(0);
          expect(metricsCountStub).to.not.have.been.called;

          await webhook.stripePaymentIntentFailed(event);
          await subscription.reload();
          await order.reload();
          expect(order.status).to.equal(OrderStatuses.ERROR);
          expect(subscription.chargeRetryCount).to.equal(1);
          expect(subscription.isActive).to.equal(true);
          expect(metricsCountStub).to.have.been.calledOnce;
        });

        for (const initialRetryCount of [0, MAX_RETRIES - 2, MAX_RETRIES - 1]) {
          it(`does not apply a redelivered failure twice with ${initialRetryCount} previous retries`, async () => {
            sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            const subscription = await fakeSubscription({
              CollectiveId: order.collective.id,
              interval: 'month',
              isActive: true,
              chargeRetryCount: initialRetryCount,
              nextPeriodStart: new Date('2026-04-01T00:00:00Z'),
              nextChargeDate: new Date('2026-04-01T00:00:00Z'),
            });
            await order.update({ interval: 'month', SubscriptionId: subscription.id });

            await webhook.stripePaymentIntentFailed(event);
            await subscription.reload();
            const firstFailure = {
              chargeRetryCount: subscription.chargeRetryCount,
              nextChargeDate: subscription.nextChargeDate,
              nextPeriodStart: subscription.nextPeriodStart,
              isActive: subscription.isActive,
              deactivatedAt: subscription.deactivatedAt,
              updatedAt: subscription.updatedAt,
            };
            const exceededAttempts = initialRetryCount + 1 >= MAX_RETRIES;
            expect(subscription.isActive).to.equal(!exceededAttempts);
            if (!exceededAttempts) {
              expect(subscription.chargeRetryCount).to.equal(initialRetryCount + 1);
            }

            // Redelivery on another day must not move the retry date or the deactivation timestamp.
            const clock = sandbox.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
            clock.tick(24 * 60 * 60 * 1000);
            for (let delivery = 0; delivery <= MAX_RETRIES; delivery++) {
              await webhook.stripePaymentIntentFailed(event);
            }
            await subscription.reload();
            await order.reload();

            expect(subscription.chargeRetryCount).to.equal(firstFailure.chargeRetryCount);
            expect(subscription.nextChargeDate).to.eql(firstFailure.nextChargeDate);
            expect(subscription.nextPeriodStart).to.eql(firstFailure.nextPeriodStart);
            expect(subscription.isActive).to.equal(firstFailure.isActive);
            expect(subscription.deactivatedAt).to.eql(firstFailure.deactivatedAt);
            expect(subscription.updatedAt).to.eql(firstFailure.updatedAt);
            expect(order.status).to.equal(exceededAttempts ? OrderStatuses.CANCELLED : OrderStatuses.ERROR);
            expect(metricsCountStub).to.have.been.calledOnce;
          });
        }

        it('counts a new asynchronous payment attempt after a previous failure', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          const subscription = await fakeSubscription({
            CollectiveId: order.collective.id,
            interval: 'month',
            isActive: true,
            chargeRetryCount: 0,
          });
          await order.update({ interval: 'month', SubscriptionId: subscription.id });
          await webhook.stripePaymentIntentFailed(event);
          await subscription.reload();
          expect(subscription.chargeRetryCount).to.equal(1);

          // The provider stores a new PaymentIntent; recurring processing sets PROCESSING for an async confirmation.
          const newPaymentIntent = { ...event.data.object, id: randStr('pi_retry') };
          await order.reload();
          order.Subscription = subscription;
          sandbox.stub(libPayments, 'processOrder').callsFake(async processingOrder => {
            await processingOrder.update({
              data: { ...processingOrder.data, stripePaymentIntent: newPaymentIntent },
            });
          });
          const result = await processOrderWithSubscription(order, {});
          expect(result.status).to.equal('processing');
          await order.reload();
          expect(order.status).to.equal(OrderStatuses.PROCESSING);
          const newEvent = { ...event, data: { object: newPaymentIntent } };
          await webhook.stripePaymentIntentFailed(newEvent);
          await subscription.reload();
          expect(subscription.chargeRetryCount).to.equal(2);

          // A late event for the previous PaymentIntent must not affect the current attempt.
          await webhook.stripePaymentIntentFailed(event);
          await webhook.stripePaymentIntentFailed(newEvent);
          await subscription.reload();
          expect(subscription.chargeRetryCount).to.equal(2);
          expect(subscription.isActive).to.equal(true);
          expect(metricsCountStub).to.have.been.calledTwice;
        });

        for (const orderStatus of [OrderStatuses.ERROR, OrderStatuses.CANCELLED]) {
          it(`preserves the subscription when the order is already ${orderStatus}`, async () => {
            sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
            const subscription = await fakeSubscription({
              CollectiveId: order.collective.id,
              interval: 'month',
              isActive: orderStatus !== OrderStatuses.CANCELLED,
              chargeRetryCount: 1,
            });
            await order.update({ interval: 'month', SubscriptionId: subscription.id, status: orderStatus });
            const before = subscription.toJSON();

            // Synchronous failures are already counted by processOrderWithSubscription, which saves ERROR.
            await webhook.stripePaymentIntentFailed(event);
            await subscription.reload();
            await order.reload();

            expect(subscription.toJSON()).to.eql(before);
            expect(order.status).to.equal(orderStatus);
            expect(metricsCountStub).to.not.have.been.called;
          });
        }

        it('counts each synchronous retry in recurring processing without recounting its webhook', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          const subscription = await fakeSubscription({
            interval: 'month',
            isActive: true,
            chargeRetryCount: 0,
          });
          await order.update({ interval: 'month', SubscriptionId: subscription.id, status: OrderStatuses.ACTIVE });
          order.Subscription = subscription;
          sandbox.stub(libPayments, 'processOrder').rejects(new Error('Your card was declined.'));

          for (const retryCount of [1, 2]) {
            const result = await processOrderWithSubscription(order, {});
            expect(result.status).to.equal('failure');
            await order.reload();
            await subscription.reload();
            expect(order.status).to.equal(OrderStatuses.ERROR);
            expect(subscription.chargeRetryCount).to.equal(retryCount);

            await webhook.stripePaymentIntentFailed(event);
            await subscription.reload();
            await order.reload();
            expect(subscription.chargeRetryCount).to.equal(retryCount);
            expect(subscription.isActive).to.equal(true);
          }
          expect(metricsCountStub).to.have.been.calledTwice;
        });

        it('increments chargeRetryCount and reschedules nextChargeDate when below MAX_RETRIES', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          set(event, 'data.object.last_payment_error', { message: 'card_declined' });

          const subscription = await fakeSubscription({
            CollectiveId: order.collective.id,
            interval: 'month',
            isActive: true,
            chargeRetryCount: 0,
            nextPeriodStart: new Date('2026-04-01 0:0'),
            nextChargeDate: new Date('2026-04-01 0:0'),
          });
          await order.update({ interval: 'month', SubscriptionId: subscription.id });

          await webhook.stripePaymentIntentFailed(event);
          await subscription.reload();
          await order.reload();

          // Subscription stays active and the retry count is bumped to schedule a retry attempt
          expect(subscription.isActive).to.equal(true);
          expect(subscription.deactivatedAt).to.be.null;
          expect(subscription.chargeRetryCount).to.equal(1);
          expect(subscription.nextChargeDate.getTime()).to.be.greaterThan(new Date('2026-04-01 0:0').getTime());
          expect(order.status).to.equal(OrderStatuses.ERROR);
        });

        it('cancels the subscription and order when chargeRetryCount reaches MAX_RETRIES', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          set(event, 'data.object.last_payment_error', { message: 'card_declined' });

          const subscription = await fakeSubscription({
            CollectiveId: order.collective.id,
            interval: 'month',
            isActive: true,
            chargeRetryCount: MAX_RETRIES - 1,
          });
          await order.update({ interval: 'month', SubscriptionId: subscription.id });

          await webhook.stripePaymentIntentFailed(event);
          await subscription.reload();
          await order.reload();

          expect(subscription.isActive).to.equal(false);
          expect(subscription.deactivatedAt).to.not.be.null;
          expect(order.status).to.equal(OrderStatuses.CANCELLED);
        });

        it('still calls sendOrderFailedEmail for subscription failures', async () => {
          sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
          set(event, 'data.object.last_payment_error', { message: 'card_declined' });

          const subscription = await fakeSubscription({
            CollectiveId: order.collective.id,
            interval: 'month',
            isActive: true,
            chargeRetryCount: 1,
          });
          await order.update({ interval: 'month', SubscriptionId: subscription.id });

          await webhook.stripePaymentIntentFailed(event);

          assert.calledOnceWithMatch(libPayments.sendOrderFailedEmail, { dataValues: { id: order.id } });
        });
      });

      it('keeps the order CANCELLED when the user cancelled before the failure webhook arrived', async () => {
        sandbox.stub(libPayments, 'sendOrderFailedEmail').resolves();
        set(event, 'data.object.last_payment_error', { message: 'card_declined' });

        // User cancelled while the async charge was still being processed
        await order.update({
          status: OrderStatuses.CANCELLED,
        });

        await webhook.stripePaymentIntentFailed(event);
        await order.reload();

        expect(order.status).to.equal(OrderStatuses.CANCELLED);
        assert.calledOnceWithMatch(libPayments.sendOrderFailedEmail, { dataValues: { id: order.id } });
      });
    });
  });

  describe('mandate.updated', () => {
    it('saves mandate to payment method', async () => {
      const stripePaymentMethodId = randStr('pm_');
      const paymentMethod = await fakePaymentMethod({
        type: PAYMENT_METHOD_TYPE.SEPA_DEBIT,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        saved: true,
        data: {
          stripePaymentMethodId,
        },
      });

      await webhook.mandateUpdated({
        id: 'evt_id',
        type: 'mandate.updated',
        object: 'event',
        api_version: '',
        livemode: true,
        request: null,
        created: 0,
        pending_webhooks: 0,
        data: {
          object: {
            id: 'mandate_1234',
            type: 'multi_use',
            status: 'active',
            payment_method: stripePaymentMethodId,
          } as Stripe.Mandate,
        },
      });

      await paymentMethod.reload();

      expect(paymentMethod.data.stripeMandate).to.eql({
        id: 'mandate_1234',
        type: 'multi_use',
        status: 'active',
        payment_method: stripePaymentMethodId,
      });
    });

    it('updates mandate to inactive', async () => {
      const stripePaymentMethodId = randStr('pm_');
      const paymentMethod = await fakePaymentMethod({
        type: PAYMENT_METHOD_TYPE.SEPA_DEBIT,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        saved: true,
        data: {
          stripePaymentMethodId,
          stripeMandate: {
            id: 'mandate_1234',
            type: 'multi_use',
            status: 'active',
            payment_method: stripePaymentMethodId,
          },
        },
      });

      await webhook.mandateUpdated({
        id: 'evt_id',
        type: 'mandate.updated',
        object: 'event',
        api_version: '',
        livemode: true,
        request: null,
        created: 0,
        pending_webhooks: 0,
        data: {
          object: {
            id: 'mandate_1234',
            type: 'multi_use',
            status: 'inactive',
            payment_method: stripePaymentMethodId,
          } as Stripe.Mandate,
        },
      });

      await paymentMethod.reload();

      expect(paymentMethod.data.stripeMandate.status).to.equal('inactive');
      expect(paymentMethod.saved).to.be.false;
    });

    it('create payment method with mandate if not exists', async () => {
      const stripePaymentMethodId = randStr('pm_');

      sandbox.stub(stripe.paymentMethods, 'retrieve').resolves({
        id: stripePaymentMethodId,
        type: 'sepa_debit',
        sepa_debit: {
          bank_code: 'abcd',
          last4: '1234',
        },
      });

      await webhook.mandateUpdated({
        id: 'evt_id',
        type: 'mandate.updated',
        object: 'event',
        api_version: '',
        livemode: true,
        request: null,
        created: 0,
        pending_webhooks: 0,
        data: {
          object: {
            id: 'mandate_1234',
            type: 'multi_use',
            status: 'active',
            payment_method: stripePaymentMethodId,
          } as Stripe.Mandate,
        },
      });

      const paymentMethod = await models.PaymentMethod.findOne({
        where: {
          data: {
            stripePaymentMethodId,
          },
        },
      });

      expect(paymentMethod).to.exist;
      expect(paymentMethod.data.stripeMandate).to.eql({
        id: 'mandate_1234',
        type: 'multi_use',
        status: 'active',
        payment_method: stripePaymentMethodId,
      });
    });

    it('received before customer is attached to payment method', async () => {
      const stripePaymentMethodId = randStr('pm_');
      const stripeAccount = randStr('acc_');
      const stripeCustomer = randStr('cus_');

      const collective = await fakeCollective();

      await fakeConnectedAccount({
        service: Service.STRIPE_CUSTOMER,
        username: stripeCustomer,
        clientId: stripeAccount,
        CollectiveId: collective.id,
      });

      sandbox.stub(stripe.paymentMethods, 'retrieve').resolves({
        id: stripePaymentMethodId,
        type: 'sepa_debit',
        sepa_debit: {},
      });

      await webhook.mandateUpdated({
        id: 'evt_id',
        account: stripeAccount,
        type: 'mandate.updated',
        object: 'event',
        api_version: '',
        livemode: true,
        request: null,
        created: 0,
        pending_webhooks: 0,
        data: {
          object: {
            id: 'mandate_1234',
            type: 'multi_use',
            status: 'active',
            payment_method: stripePaymentMethodId,
          } as Stripe.Mandate,
        },
      });

      const paymentMethod = await models.PaymentMethod.findOne({
        where: {
          data: {
            stripePaymentMethodId,
            stripeAccount,
          },
        },
      });

      expect(paymentMethod.customerId).to.be.null;
      expect(paymentMethod.CollectiveId).to.be.null;

      expect(paymentMethod.data.stripeMandate).to.eql({
        id: 'mandate_1234',
        type: 'multi_use',
        status: 'active',
        payment_method: stripePaymentMethodId,
      });

      await webhook.paymentMethodAttached({
        id: 'evt_id',
        account: stripeAccount,
        type: 'payment_method.attached',
        object: 'event',
        api_version: '',
        livemode: true,
        request: null,
        created: 0,
        pending_webhooks: 0,
        data: {
          object: {
            id: stripePaymentMethodId,
            type: 'sepa_debit',
            sepa_debit: {},
            customer: stripeCustomer,
          } as Stripe.PaymentMethod,
        },
      });

      await paymentMethod.reload();

      expect(paymentMethod.customerId).to.eql(stripeCustomer);
      expect(paymentMethod.CollectiveId).to.eql(collective.id);

      expect(paymentMethod.data.stripeMandate).to.eql({
        id: 'mandate_1234',
        type: 'multi_use',
        status: 'active',
        payment_method: stripePaymentMethodId,
      });
    });

    it.skip('ignores unknown Stripe payment method type', async () => {
      const stripePaymentMethodId = randStr('pm_');

      sandbox.stub(stripe.paymentMethods, 'retrieve').resolves({
        id: stripePaymentMethodId,
        type: 'link',
        link: {},
      });

      await webhook.mandateUpdated({
        id: 'evt_id',
        type: 'mandate.updated',
        object: 'event',
        api_version: '',
        livemode: true,
        request: null,
        created: 0,
        pending_webhooks: 0,
        data: {
          object: {
            id: 'mandate_1234',
            type: 'multi_use',
            status: 'active',
            payment_method: stripePaymentMethodId,
          } as Stripe.Mandate,
        },
      });

      const paymentMethod = await models.PaymentMethod.findOne({
        where: {
          data: {
            stripePaymentMethodId,
          },
        },
      });

      expect(paymentMethod).to.not.exist;
    });
  });

  describe('expense', () => {
    let fromCollectiveHost: Collective;
    let fromCollective: Collective;
    let payee: Collective;
    let expense: Expense;
    let event;
    beforeEach(async () => {
      fromCollectiveHost = await fakeActiveHost();
      fromCollective = await fakeCollective({
        HostCollectiveId: fromCollectiveHost.id,
      });
      await fakeConnectedAccount({
        CollectiveId: fromCollectiveHost.id,
        service: 'stripe',
        username: 'testUserName',
        token: 'faketoken',
      });

      payee = await fakeCollective();

      // Stripe expense payments are not necessarily paid through a STRIPE payout method (card-funded
      // expense payments carry the payee's method), so use an explicit non-Stripe one here.
      const payoutMethod = await fakePayoutMethod({ type: PayoutMethodTypes.BANK_ACCOUNT });

      expense = await fakeExpense({
        status: ExpenseStatuses.APPROVED,
        Collective: payee.id,
        FromCollectiveId: fromCollective.id,
        PayoutMethodId: payoutMethod.id,
        currency: 'USD',
        amount: 100e2,
        description: 'A expense to be paid with stripe',
        data: { stripePaymentIntent: { id: randStr('pi_fake') } },
      });

      sandbox.stub(stripe.paymentMethods, 'retrieve').resolves({
        type: 'us_bank_account',
        us_bank_account: {
          name: 'Test Bank',
          last4: '1234',
        },
      });

      sandbox.stub(transactions, 'createTransactionsFromPaidStripeExpense').resolves();

      event = {
        data: {
          object: {
            id: expense.data.stripePaymentIntent.id,
            amount: 100e2,
            currency: 'usd',
            payment_method: randStr('pm_fake'),
            latest_charge: {
              amount: 100e2,
              amount_captured: 100e2,
              amount_refunded: 0,
              application_fee: null,
              application_fee_amount: null,
            },
          },
        },
      };
    });

    describe('paymentIntentSucceeded', () => {
      it('marks expense as PAID', async () => {
        await webhook.stripePaymentIntentSucceeded(event);

        await expense.reload();
        expect(expense.status).to.eql(ExpenseStatuses.PAID);
      });

      it('records a successful payment outcome metric when the expense payment succeeds', async () => {
        await webhook.stripePaymentIntentSucceeded(event);

        await expense.reload();
        expect(expense.status).to.eql(ExpenseStatuses.PAID);
        expect(metricsCountStub).to.have.been.calledOnce;
        expect(metricsCountStub.firstCall.args).to.deep.equal([
          'thirdparty.stripe.payment.succeeded',
          1,
          { attributes: { flow: 'payout', method: 'BANK_ACCOUNT' } },
        ]);
      });

      it('does not mark expense as PAID when PaymentIntent amount does not match the expense', async () => {
        event.data.object.amount = 50e2;
        await webhook.stripePaymentIntentSucceeded(event);

        await expense.reload();
        expect(expense.status).to.eql(ExpenseStatuses.APPROVED);
        expect(transactions.createTransactionsFromPaidStripeExpense).to.not.have.been.called;
        expect(metricsCountStub.called).to.be.false;
      });

      it('does not mark expense as PAID when PaymentIntent currency does not match the expense', async () => {
        event.data.object.currency = 'eur';
        await webhook.stripePaymentIntentSucceeded(event);

        await expense.reload();
        expect(expense.status).to.eql(ExpenseStatuses.APPROVED);
        expect(transactions.createTransactionsFromPaidStripeExpense).to.not.have.been.called;
      });
    });

    describe('paymentIntentProcessing', () => {
      it('marks expense as PROGRESSING', async () => {
        await webhook.stripePaymentIntentProcessing(event);

        await expense.reload();
        expect(expense.status).to.eql(ExpenseStatuses.PROCESSING);
      });
    });

    describe('paymentIntentFailed', () => {
      it('marks expense as ERROR if expense was processing', async () => {
        await webhook.stripePaymentIntentProcessing(event);
        await webhook.stripePaymentIntentFailed(event);

        await expense.reload();
        expect(expense.status).to.eql(ExpenseStatuses.ERROR);
      });

      it('records a failed payment outcome metric when the expense payment fails', async () => {
        event.data.object.last_payment_error = { code: 'card_declined', message: 'Your card was declined.' };
        await webhook.stripePaymentIntentProcessing(event);
        await webhook.stripePaymentIntentFailed(event);

        await expense.reload();
        expect(expense.status).to.eql(ExpenseStatuses.ERROR);
        expect(metricsCountStub).to.have.been.calledOnce;
        expect(metricsCountStub.firstCall.args).to.deep.equal([
          'thirdparty.stripe.payment.failed',
          1,
          { attributes: { flow: 'payout', method: 'BANK_ACCOUNT', error_type: 'card_declined' } },
        ]);
      });

      it('keeps expense status if payment failed immediately', async () => {
        await webhook.stripePaymentIntentFailed(event);

        await expense.reload();
        expect(expense.status).to.eql(ExpenseStatuses.APPROVED);
        expect(metricsCountStub.called).to.be.false;
      });
    });
  });

  describe('createOrUpdatePaymentMethod()', () => {
    const PLATFORM_ACCOUNT_ID = config.stripe.accountId;

    it('matches a legacy platform PM that has no data.stripeAccount', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ CreatedByUserId: user.id });
      const stripePaymentMethodId = randStr('pm_legacy_');
      const existingPm = await fakePaymentMethod({
        CollectiveId: collective.id,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        data: { stripePaymentMethodId },
      });
      const retrieveStub = sandbox.stub(stripe.paymentMethods, 'retrieve');

      const result = await webhook.createOrUpdatePaymentMethod(collective.id, user.id, PLATFORM_ACCOUNT_ID, {
        payment_method: stripePaymentMethodId,
      } as Stripe.PaymentIntent);

      expect(result.id).to.equal(existingPm.id);
      assert.notCalled(retrieveStub);
      const count = await models.PaymentMethod.count({ where: { data: { stripePaymentMethodId } } });
      expect(count).to.equal(1);
    });

    it('matches a platform PM that has data.stripeAccount set to the platform id', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective({ CreatedByUserId: user.id });
      const stripePaymentMethodId = randStr('pm_platform_');
      const existingPm = await fakePaymentMethod({
        CollectiveId: collective.id,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        data: { stripePaymentMethodId, stripeAccount: PLATFORM_ACCOUNT_ID },
      });
      const retrieveStub = sandbox.stub(stripe.paymentMethods, 'retrieve');

      const result = await webhook.createOrUpdatePaymentMethod(collective.id, user.id, PLATFORM_ACCOUNT_ID, {
        payment_method: stripePaymentMethodId,
      } as Stripe.PaymentIntent);

      expect(result.id).to.equal(existingPm.id);
      assert.notCalled(retrieveStub);
      const count = await models.PaymentMethod.count({ where: { data: { stripePaymentMethodId } } });
      expect(count).to.equal(1);
    });
  });
});
