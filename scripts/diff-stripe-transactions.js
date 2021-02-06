#!/usr/bin/env ./node_modules/.bin/babel-node
import '../server/env';

import { get, last } from 'lodash';

import stripe from '../server/lib/stripe';
import models from '../server/models';

if (process.argv.length < 3) {
  console.error('Usage: ./scripts/diff-stripe-transactions.js HOST_SLUG [NB_CHARGES_TO_CHECK=100] [LAST_CHARGE_ID]');
  process.exit(1);
}

const HOST_SLUG = process.argv[2];
const NB_CHARGES_TO_CHECK = parseInt(process.argv[3]) || 100;
const LAST_CHARGE_ID = process.argv[4] || undefined;
const NB_CHARGES_PER_QUERY = 100; // Max allowed by Stripe
const NB_PAGES = NB_CHARGES_TO_CHECK / NB_CHARGES_PER_QUERY;

async function checkCharge(charge) {
  if (charge.failure_code) {
    // Ignore failed transaction
    console.log(`Ignoring ${charge.id} (failed transaction)`);
    return;
  }

  let transaction = await models.Transaction.findOne({
    where: { data: { charge: { id: charge.id } } },
    order: [['id', 'DESC']],
    // The JOIN is only here to optimize the query as searching in a JSON for thousands
    // of transaction can be pretty expensive.
    include: [
      {
        model: models.PaymentMethod,
        as: 'PaymentMethod',
        required: true,
        where: {
          customerId: charge.customer,
          service: 'stripe',
        },
      },
    ],
  });

  if (!transaction) {
    // This is an expensive query, we only run it if the above fails
    transaction = await models.Transaction.findOne({
      where: { data: { charge: { id: charge.id } } },
      order: [['id', 'DESC']],
    });

    if (!transaction) {
      console.error(`🚨️ Missing transaction for stripe charge ${charge.id}`);
    }
  }
}

const getHostStripeAccountUsername = async slug => {
  const hostId = (await models.Collective.findOne({ where: { slug } }))?.id;
  if (!hostId) {
    throw new Error('Host not found');
  }

  const stripeAccount = await models.ConnectedAccount.findOne({ where: { service: 'stripe', CollectiveId: hostId } });
  if (!stripeAccount) {
    throw new Error('No stripe account found for this host');
  }

  return stripeAccount.username;
};

async function main() {
  const stripeUserName = await getHostStripeAccountUsername(HOST_SLUG);
  let lastChargeId = LAST_CHARGE_ID;
  let totalAlreadyChecked = 0;

  console.info(`Starting the diff of Stripe VS Transactions for the latest ${NB_CHARGES_TO_CHECK} charges`);
  for (let pageNum = 0; pageNum < NB_PAGES; pageNum++) {
    // Log the current page
    const nbToCheckInThisPage = Math.min(NB_CHARGES_PER_QUERY, NB_CHARGES_TO_CHECK - totalAlreadyChecked);
    console.info(`🔎️ Checking transactions ${totalAlreadyChecked} to ${totalAlreadyChecked + nbToCheckInThisPage}`);

    // Retrieve the list and check all charges
    const charges = await stripe.charges.list(
      { limit: nbToCheckInThisPage, starting_after: lastChargeId }, // eslint-disable-line camelcase
      { stripeAccount: stripeUserName },
    );
    for (let idx = 0; idx < charges.data.length; idx++) {
      await checkCharge(charges.data[idx]);
      totalAlreadyChecked += 1;
      if (idx >= nbToCheckInThisPage) {
        break;
      }
    }

    // We reached the end
    if (!charges.has_more) {
      break;
    }

    // Register last charge for pagination
    lastChargeId = get(last(charges.data), 'id');
  }

  console.info('--------------------------------------\nDone!');
}

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
