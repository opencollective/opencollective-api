import { expect } from 'chai';

import PaymentIntentStatus from '../../../../server/constants/payment-intent-status';
import PaymentIntentType from '../../../../server/constants/payment-intent-type';
import { computePaymentIntentAmountPledged } from '../../../../server/lib/payment-intents/amounts';
import models from '../../../../server/models';
import { fakeExpense, fakeOrder } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('server/lib/payment-intents/amounts', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  describe('computePaymentIntentAmountPledged', () => {
    it('returns the linked order total amount', async () => {
      const order = await fakeOrder({ totalAmount: 7500, currency: 'USD' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.Contribution,
        OrderId: order.id,
      });

      const amount = await computePaymentIntentAmountPledged(paymentIntent);

      expect(amount).to.deep.eq({ value: 7500, currency: 'USD' });
    });

    it('returns the linked expense amount', async () => {
      const expense = await fakeExpense({ amount: 4200, currency: 'EUR' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.PaymentRequest,
        ExpenseId: expense.id,
      });

      const amount = await computePaymentIntentAmountPledged(paymentIntent);

      expect(amount).to.deep.eq({ value: 4200, currency: 'EUR' });
    });

    it('prefers the linked order over the linked expense', async () => {
      const order = await fakeOrder({ totalAmount: 1000, currency: 'USD' });
      const expense = await fakeExpense({ amount: 2000, currency: 'USD' });
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PENDING,
        type: PaymentIntentType.Contribution,
        OrderId: order.id,
        ExpenseId: expense.id,
      });

      const amount = await computePaymentIntentAmountPledged(paymentIntent);

      expect(amount).to.deep.eq({ value: 1000, currency: 'USD' });
    });

    it('returns null when no order or expense is linked', async () => {
      const paymentIntent = await models.PaymentIntent.create({
        status: PaymentIntentStatus.PAID,
        type: PaymentIntentType.Other,
      });

      const amount = await computePaymentIntentAmountPledged(paymentIntent);

      expect(amount).to.be.null;
    });
  });
});
