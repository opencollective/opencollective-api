import '../../server/env';

import stripe from '../../server/lib/stripe';

const IS_DRY = !!process.env.DRY;

const refund = async (stripeAccount, paymentIntentId) => {
  const paymentIntent = await stripe.paymentIntents.retrieve(
    paymentIntentId,
    { expand: ['latest_charge'] },
    { stripeAccount },
  );
  const charge = paymentIntent.latest_charge || (paymentIntent as any).charges.data[0];

  console.log(
    `Amount: ${charge.amount}, livemode: ${charge.livemode}, status: ${charge.status}, refunded: ${charge.refunded}, type: ${charge.payment_method_details.type}`,
  );

  if (!IS_DRY) {
    const refund = await stripe.refunds.create(
      // eslint-disable-next-line camelcase
      { payment_intent: paymentIntentId, refund_application_fee: true },
      { stripeAccount },
    );

    if (refund.status === 'succeeded' || refund.status === 'pending') {
      console.log('Refund succeeded or pending!', paymentIntent);
    } else {
      throw new Error(`Could not refund payment intent ${paymentIntent}`, { cause: refund });
    }
  }
};

// npm run script scripts/fixes/refund-stripe-paymentIntent.ts <stripeAccount> <paymentIntent>
// To refund multiple, create a text file with a payment intent id per line
//
// e.g.:    cat paymentIntentsToRefund.txt // a payment intent id per line
//          pi_1
//          pi_2
//
// cat paymentIntentsToRefund.txt | xargs -n 1 npm run script scripts/fixes/refund-stripe-paymentIntent.ts <stripeAccount>

const main = async () => {
  if (IS_DRY) {
    console.info('RUNNING IN DRY MODE!');
  }
  const stripeAccount = process.argv[2];
  const paymentIntentId = process.argv[3];

  if (!stripeAccount || !paymentIntentId) {
    console.log('Usage npm run script scripts/fixes/refund-stripe-paymentIntent.ts stripeAccount paymentIntent');
  } else {
    console.log(`Refunding payment intent ${paymentIntentId}`);

    try {
      await refund(stripeAccount, paymentIntentId);
    } catch (e) {
      if (e?.raw?.code === 'charge_already_refunded') {
        console.log(`Already refunded ${paymentIntentId}`);
      } else {
        throw e;
      }
    }
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(255);
  });
