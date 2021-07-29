#!/usr/bin/env ./node_modules/.bin/babel-node
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
  if (transaction.data?.refund?.status === 'pending') {
    throw new Error(`Transaction #${transaction.id} refund was already requested and it is pending`);
  }

  /* From which stripe account it's going to be refunded */
  const collective = await models.Collective.findByPk(
    transaction.type === 'CREDIT' ? transaction.CollectiveId : transaction.FromCollectiveId,
  );
  const hostStripeAccount = await collective.getHostStripeAccount();

  /* Refund both charge & application fee */
  const shouldRefundApplicationFee = transaction.platformFeeInHostCurrency > 0;
  if (!IS_DRY) {
    const refund = await stripe.refunds.create(
      { charge: chargeId, refund_application_fee: shouldRefundApplicationFee }, // eslint-disable-line camelcase
      { stripeAccount: hostStripeAccount.username },
    );

    if (refund.status === 'succeeded') {
      await transaction.update({ data: { ...transaction.data, refund } });
      console.log('Refunded succeeded!');
    } else {
      console.warn(`Could not refund transactio #${transaction.id}`, refund);
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
