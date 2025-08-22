import config from 'config';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { Expense, PaymentMethod } from '../../models';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import stripe, { convertToStripeAmount } from '../stripe';

export async function chargePlatformBillingExpenseWithStripe(expense: Expense) {
  const payoutMethod = await expense.getPayoutMethod();
  if (payoutMethod.type !== PayoutMethodTypes.STRIPE) {
    throw new Error('Expense payout method must be set to Stripe');
  }

  const paymentMethod = await getStripePlatformPaymentMethod(expense.CollectiveId);
  if (!paymentMethod) {
    throw new Error(`Collective ${expense.CollectiveId} has no valid saved stripe payment method`);
  }

  const paymentIntentResult = await createAndConfirmStripePaymentIntent(
    expense,
    paymentMethod.customerId,
    paymentMethod.token,
  );

  await expense.update({
    data: {
      ...expense.data,
      paymentIntent: paymentIntentResult,
    },
  });

  if (!['processing', 'succeeded'].includes(paymentIntentResult.status)) {
    throw new Error(`Unexpected payment intent #${paymentIntentResult.id} status: ${paymentIntentResult.status}`);
  }

  return;
}

async function createAndConfirmStripePaymentIntent(
  expense: Expense,
  stripeCustomerId: string,
  stripePaymentMethodId: string,
) {
  const payer = await expense.getCollective();

  return await stripe.paymentIntents.create({
    customer: stripeCustomerId,
    description: `Expense ${expense.id}: ${expense.description}`,
    amount: convertToStripeAmount(expense.currency, expense.amount),
    currency: expense.currency,
    /* eslint-disable camelcase */
    off_session: true,
    payment_method: stripePaymentMethodId,
    /* eslint-enable camelcase */
    confirm: true,
    metadata: {
      from: `${config.host.website}/${payer.slug}`,
      to: `${config.host.website}/ofitech`,
      expenseId: expense.id,
    },
  });
}

async function getStripePlatformPaymentMethod(collectiveId: number): Promise<PaymentMethod> {
  return await PaymentMethod.findOne({
    where: {
      CollectiveId: collectiveId,
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      saved: true,

      type: PAYMENT_METHOD_TYPE.CREDITCARD, // only auto charge cards for now.

      data: {
        stripeAccount: config.stripe.accountId,
      },
    },
  });
}
