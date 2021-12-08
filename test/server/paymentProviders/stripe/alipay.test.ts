/* eslint-disable camelcase */
import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { idEncode, IDENTIFIER_TYPES } from '../../../../server/graphql/v2/identifiers';
import stripe from '../../../../server/lib/stripe';
import alipay from '../../../../server/paymentProviders/stripe/alipay';
import {
  fakeCollective,
  fakeConnectedAccount,
  fakeOrder,
  fakePaymentMethod,
  fakeUser,
} from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';
describe('server/paymentProviders/stripe/alipay', () => {
  const sandbox = createSandbox();

  let order;
  before(async () => {
    await utils.resetTestDB();
    const user = await fakeUser();
    const host = await fakeCollective({ isHostAccount: true });
    await fakeConnectedAccount({
      service: 'stripe',
      token: 'tok_1Be9noDjPFcHOcTmT574CrEv',
      CollectiveId: host.id,
    });
    const collective = await fakeCollective({ isHostAccount: false, HostCollectiveId: host.id });
    const paymentMethod = await fakePaymentMethod({
      name: 'alipay',
      service: 'stripe',
      type: 'alipay',
      CollectiveId: user.collective.id,
    });
    order = await fakeOrder({
      CreatedByUserId: user.id,
      FromCollectiveId: user.CollectiveId,
      CollectiveId: collective.id,
      PaymentMethodId: paymentMethod.id,
      totalAmount: 10000,
      currency: 'USD',
    });
  });
  after(sandbox.restore);

  describe('processOrder()', () => {
    before(() => {
      sandbox.stub(stripe.paymentIntents, 'create').resolves({ id: 'pi_test', status: 'chill' });
    });

    it('should create intent and throw Payment Intent require action error', async () => {
      let error;
      await alipay.processOrder(order).catch(e => {
        error = e;
      });

      const call = stripe.paymentIntents.create.getCall(0);
      expect(call).to.exists;
      expect(call).to.have.nested.property('firstArg.amount', 10000);
      expect(call).to.have.nested.property('firstArg.payment_method_types[0]', 'alipay');
      expect(error).to.have.property('stripeAccount');
      expect(error.stripeResponse).to.have.property('paymentIntent');
      expect(error.stripeResponse).to.have.nested.property('paymentIntent.id', 'pi_test');
    });
  });

  describe('confirmOrder()', () => {
    const res = { sendStatus: sandbox.stub(), redirect: sandbox.stub() };
    const next = sandbox.stub();

    before(async () => {
      await order.update({ status: 'REQUIRE_CLIENT_CONFIRMATION' });
      sandbox.stub(stripe.paymentIntents, 'retrieve').resolves({
        id: 'pi_test',
        status: 'chill',
        charges: { data: [{ id: 'ch_test', balance_transaction: 'bt_chargetest' }] },
      });
      sandbox.stub(stripe.balanceTransactions, 'retrieve').resolves({
        id: 'bt_chargetest',
        status: 'chill',
        currency: 'usd',
        amount: 10000,
        fee: 0,
        fee_details: [],
      });

      const req = {
        query: {
          OrderId: idEncode(order.id, IDENTIFIER_TYPES.ORDER),
          payment_intent: 'pi_test',
          redirect_status: 'succeeded',
        },
      };
      await alipay.confirmOrder(req as any, res as any, next);
    });

    it('should create transactions when it succeeds', async () => {
      const transactions = await order.getTransactions();

      expect(transactions).to.be.an('array').of.length(4);

      const credit = transactions.find(t => t.type === 'CREDIT' && t.kind === 'CONTRIBUTION');
      expect(credit).to.have.property('amount', 10000);
      expect(credit).to.have.property('currency', 'USD');
      expect(credit).to.have.property('OrderId', order.id);
    });

    it('should update order status', async () => {
      await order.reload();

      expect(order).to.have.property('status', 'PAID');
    });

    it('should redirect to donate success page', () => {
      expect(res.redirect.getCall(0))
        .to.have.nested.property('firstArg')
        .include(`/donate/success?OrderId=${idEncode(order.id, IDENTIFIER_TYPES.ORDER)}`);
    });
  });
});
