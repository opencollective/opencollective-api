/* eslint-disable camelcase */

import { expect } from 'chai';
import { assert, createSandbox } from 'sinon';

import { Service } from '../../../../server/constants/connected_account';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import cache from '../../../../server/lib/cache';
import stripe from '../../../../server/lib/stripe';
import * as common from '../../../../server/paymentProviders/stripe/common';
import creditcard from '../../../../server/paymentProviders/stripe/creditcard';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeOrder,
  fakePaymentMethod,
  randStr,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/paymentProviders/stripe/creditcard', () => {
  describe('#processOrder()', async () => {
    beforeEach(() => utils.resetTestDB());
    const stripePaymentMethodId = randStr('pm_');

    const sandbox = createSandbox();
    afterEach(sandbox.restore);

    let collective, host, paymentMethod, order;
    beforeEach(async () => {
      // platform tip transaction expects platform collective by id 8686
      await fakeCollective({ id: 8686 });

      const fromCollective = await fakeCollective();
      collective = await fakeCollective();
      host = collective.host;

      await fakeConnectedAccount({
        CollectiveId: collective.host.id,
        service: Service.STRIPE,
        username: 'acc_test',
        token: 'sk_test',
      });

      paymentMethod = await fakePaymentMethod({
        CollectiveId: fromCollective.id,
        service: PAYMENT_METHOD_SERVICE.STRIPE,
        type: PAYMENT_METHOD_TYPE.CREDITCARD,
        customerId: 'cus_test',
        token: 'tok_testtoken123456789012345',
        data: {
          stripePaymentMethodId,
        },
      });

      order = await fakeOrder({
        CreatedByUserId: fromCollective.CreatedByUserId,
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        PaymentMethodId: paymentMethod.id,
        totalAmount: 1000,
        currency: 'USD',
      });

      sandbox.stub(common, 'resolvePaymentMethodForOrder').resolves({
        id: stripePaymentMethodId,
        customer: 'cus_test',
      });
      sandbox.stub(stripe.paymentIntents, 'create').resolves({ id: 'pi_test', status: 'requires_confirmation' });
      sandbox.stub(stripe.paymentIntents, 'confirm').resolves({
        id: stripePaymentMethodId,
        status: 'succeeded',
        charges: {
          data: [{ id: 'ch_id', balance_transaction: 'txn_id' }],
        },
      });

      sandbox.stub(stripe.balanceTransactions, 'retrieve').resolves({
        amount: 1100,
        currency: 'usd',
        fee: 0,
        fee_details: [],
      });
    });

    it('should process order correctly', async () => {
      await creditcard.processOrder(order);

      assert.calledWithMatch(
        stripe.paymentIntents.create,
        {
          customer: 'cus_test',
          payment_method: stripePaymentMethodId,
        },
        {
          stripeAccount: 'acc_test',
        },
      );

      assert.calledWithMatch(
        stripe.paymentIntents.confirm,
        'pi_test',
        { payment_method: stripePaymentMethodId },
        { stripeAccount: 'acc_test' },
      );
    });

    it('has tax information stored in transaction', async () => {
      await order.update({ taxAmount: 100 });

      const transaction = await creditcard.processOrder(order);
      expect(transaction.taxAmount).to.be.equal(-100);
    });

    describe('platform tips and host revenue share', () => {
      it('should collect the platform fee as application fee', async () => {
        stripe.balanceTransactions.retrieve.resolves({
          amount: 1100,
          currency: 'usd',
          fee: 0,
          fee_details: [
            {
              type: 'application_fee',
              amount: 100,
              currency: 'usd',
              application: 'ca_',
              description: 'OpenCollective application fee',
            },
          ],
        });

        await order.update({ totalAmount: 1100, platformTipAmount: 100 });

        await creditcard.processOrder(order);

        assert.calledWithMatch(stripe.paymentIntents.create, {
          amount: 1100,
          application_fee_amount: 100,
        });
      });

      it('should collect the host revenue share', async () => {
        await order.update({ totalAmount: 1000 });
        await collective.update({ hostFeePercent: 10 });
        await host.update({ plan: 'grow-plan-2021' });
        await cache.clear();

        await creditcard.processOrder(order);

        assert.calledWithMatch(stripe.paymentIntents.create, {
          amount: 1000,
          application_fee_amount: 1000 * 0.1 * 0.15,
        });
      });

      it('should process orders correctly with zero decimal currencies', async () => {
        await order.update({
          totalAmount: 25000,
          currency: 'JPY',
          platformTipAmount: 5000,
        });

        await creditcard.processOrder(order);

        assert.calledWithMatch(stripe.paymentIntents.create, {
          currency: 'JPY',
          amount: 250,
          application_fee_amount: 50,
        });
      });

      it('should work with custom stripeHostFeeSharePercent', async () => {
        await order.update({ totalAmount: 1000 });
        await collective.update({ hostFeePercent: 10 });
        await host.update({ plan: 'grow-plan-2021', data: { plan: { stripeHostFeeSharePercent: 20 } } });
        await cache.clear();

        await creditcard.processOrder(order);

        assert.calledWithMatch(stripe.paymentIntents.create, {
          amount: 1000,
          application_fee_amount: 1000 * 0.1 * 0.2,
        });
      });

      it('should work with stripeHostFeeSharePercent = 0', async () => {
        await order.update({ totalAmount: 1000 });
        await collective.update({ hostFeePercent: 10, platformFeePercent: 0 });
        await host.update({ plan: 'grow-plan-2021', data: { plan: { stripeHostFeeSharePercent: 0 } } });
        await cache.clear();

        await creditcard.processOrder(order);

        assert.calledWithMatch(stripe.paymentIntents.create, {
          amount: 1000,
          application_fee_amount: undefined,
        });
      });

      it('should collect both', async () => {
        await collective.update({ hostFeePercent: 10 });
        await host.update({ plan: 'grow-plan-2021' });
        await cache.clear();

        await order.update({ totalAmount: 1100, platformTipAmount: 100 });

        stripe.balanceTransactions.retrieve.resolves({
          amount: 1100,
          currency: 'usd',
          fee: 0,
          fee_details: [
            {
              type: 'application_fee',
              amount: 115,
              currency: 'usd',
              application: 'ca_',
              description: 'OpenCollective application fee',
            },
          ],
        });

        await creditcard.processOrder(order);

        assert.calledWithMatch(stripe.paymentIntents.create, {
          amount: 1100,
          application_fee_amount: 1000 * 0.1 * 0.15 + 100,
        });
      });

      it('should create a debt for platform tip and share if currency does not support application_fee', async () => {
        await order.update({ currency: 'BRL', totalAmount: 1100, platformTipAmount: 100 });
        await collective.update({ hostFeePercent: 10 });
        await host.update({ currency: 'BRL', plan: 'grow-plan-2021' });
        await cache.clear();

        stripe.balanceTransactions.retrieve.resolves({
          amount: 1100,
          currency: 'BRL',
          fee_details: [],
        });

        await creditcard.processOrder(order);

        assert.calledWithMatch(stripe.paymentIntents.create, {
          amount: 1100,
          application_fee_amount: undefined,
        });

        const transactions = await order.getTransactions();
        expect(transactions.filter(t => t.kind === 'HOST_FEE_SHARE_DEBT')).to.have.lengthOf(2);
        expect(transactions.filter(t => t.kind === 'PLATFORM_TIP_DEBT')).to.have.lengthOf(2);
      });

      it('should consider platform tip eligibility', async () => {
        await order.update({ currency: 'USD', totalAmount: 1000, platformTipAmount: 0, platformTipEligible: true });
        await collective.update({ hostFeePercent: 10 });
        await host.update({ currency: 'USD', plan: 'grow-plan-2021' });
        await cache.clear();

        stripe.balanceTransactions.retrieve.resolves({
          amount: 1000,
          currency: 'USD',
          fee_details: [],
        });

        await creditcard.processOrder(order);

        assert.calledWithMatch(stripe.paymentIntents.create, {
          amount: 1000,
          application_fee_amount: undefined,
        });

        const transactions = await order.getTransactions();
        expect(transactions.filter(t => t.kind === 'HOST_FEE_SHARE')).to.have.lengthOf(0);
      });
    });
  });
});
