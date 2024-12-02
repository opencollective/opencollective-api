/* eslint-disable camelcase */

import { expect } from 'chai';
import { set } from 'lodash';
import { assert, createSandbox } from 'sinon';
import Stripe from 'stripe';

import { Service } from '../../../../server/constants/connected-account';
import FEATURE from '../../../../server/constants/feature';
import OrderStatuses from '../../../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import { TransactionKind } from '../../../../server/constants/transaction-kind';
import * as libPayments from '../../../../server/lib/payments';
import stripe from '../../../../server/lib/stripe';
import models from '../../../../server/models';
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
  let sandbox;

  beforeEach(async () => {
    await utils.resetTestDB();
    await utils.seedDefaultVendors();
    sandbox = createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
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
      const collective = await fakeCollective({ isHostAccount: true });
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

    describe('paymentIntentSucceeded()', () => {
      it('returns if no order is found', async () => {
        sandbox.stub(common, 'createChargeTransactions').throws();
        set(event, 'data.object.id', 'pi_notfound');
        await webhook.paymentIntentSucceeded(event);
        await order.reload();

        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        assert.notCalled(common.createChargeTransactions);
      });

      it('create transactions, send notifications, and updates the order', async () => {
        sandbox.stub(common, 'createChargeTransactions').resolves();
        sandbox.stub(libPayments, 'sendEmailNotifications').resolves();
        await webhook.paymentIntentSucceeded(event);

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
    });

    describe('paymentIntentProcessing()', () => {
      it('returns if no order is found', async () => {
        set(event, 'data.object.id', 'pi_notfound');
        await webhook.paymentIntentProcessing(event);
        await order.reload();

        sandbox.stub(order, 'update').throws();

        expect(order.status).to.equal(OrderStatuses.PROCESSING);
        expect(order.data.paymentIntent).to.have.property('id').not.equal('pi_notfound');
        assert.notCalled(order.update);
      });

      it('updates order.data.paymentIntent', async () => {
        sandbox.stub(stripe.paymentMethods, 'retrieve').resolves({
          type: 'us_bank_account',
          us_bank_account: {
            name: 'Test Bank',
            last4: '1234',
          },
        });

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
        assert.notCalled(order.update);
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
        assert.calledOnceWithMatch(
          libPayments.sendOrderFailedEmail,
          {
            dataValues: { id: order.id },
          },
          'Something went wrong with the payment, please contact support@opencollective.com.',
        );
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
});
