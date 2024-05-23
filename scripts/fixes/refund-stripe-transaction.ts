import '../../server/env';

import { result, toNumber } from 'lodash';

import stripe from '../../server/lib/stripe';
import models from '../../server/models';

const IS_DRY = !!process.env.DRY;

const refund = async transactionId => {
  const transaction = await models.Transaction.findByPk(transactionId);
  if (!transaction) {
    throw new Error(`Could not find transaction #${transactionId}`);
  }
  /* What's going to be refunded */
  const chargeId = result(transaction.data, 'charge.id');
  if (!chargeId) {
    throw new Error(`Transaction #${transaction.id} was not paid through stripe`);
  }

  /* From which stripe account it's going to be refunded */
  const collective = await models.Collective.findByPk(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  const hostStripeAccount = await collective.getHostStripeAccount();

  /* Refund both charge & application fee */
  if (!IS_DRY) {
    const charge = await stripe.charges.retrieve(chargeId as string, { stripeAccount: hostStripeAccount.username });
    if (charge.disputed) {
      console.log('Charge is already disputed.');
      return;
    }
    if (charge.refunded) {
      console.log('Charge is already refunded.');
      return;
    }

    const refund = await stripe.refunds.create(
      { charge: chargeId as string, refund_application_fee: true }, // eslint-disable-line camelcase
      { stripeAccount: hostStripeAccount.username },
    );

    if (refund.status === 'succeeded' || refund.status === 'pending') {
      await transaction.update({ data: { ...transaction.data, refund } });
      console.log('Refund succeeded or pending!');
    } else {
      console.warn(`Could not refund transaction #${transaction.id}`, refund);
    }
  }
};

const main = async () => {
  if (IS_DRY) {
    console.info('RUNNING IN DRY MODE!');
  }
  const transactionId = toNumber(process.argv[2]);
  if (!transactionId) {
    console.log('Usage npm run script scripts/fixes/refund-stripe-transaction.ts transactionId');
  } else {
    console.log(`Refunding transaction #${transactionId}...`);
    await refund(transactionId);
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
