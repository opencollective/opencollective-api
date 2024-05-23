import '../../server/env';

import config from 'config';
import { compact, omit } from 'lodash';
import Stripe from 'stripe';

import { Service as ConnectedAccountServices } from '../../server/constants/connected-account';
import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models from '../../server/models';
import { processTransaction } from '../../server/paymentProviders/stripe/virtual-cards';

const DRY = process.env.DRY;

async function reconcileConnectedAccount(connectedAccount) {
  const host = connectedAccount.collective;
  const cards = host.virtualCards.filter(card => card.provider === connectedAccount.service.toUpperCase());

  logger.info(`Found ${cards.length} cards connected to host #${connectedAccount.CollectiveId} ${host.slug}...`);

  for (const card of cards) {
    try {
      if (card.provider === 'STRIPE') {
        if (card.data.status === 'canceled') {
          logger.info(`\nSkipping card ${card.id}: card is canceled`);
          continue;
        }

        logger.info(`\nReconciling card ${card.id}: fetching STRIPE transactions`);

        const expenses = await models.Expense.findAll({
          where: {
            VirtualCardId: card.id,
            status: 'PAID',
          },
        });
        const synchronizedTransactionIds = compact(
          expenses.map(expense => expense.data?.transactionId || expense.data?.refundTransactionId),
        );

        const stripe = Stripe(host.slug === 'opencollective' ? config.stripe.secret : connectedAccount.token);

        const result = await stripe.issuing.transactions.list({
          card: card.id,
          limit: 100,
        });

        const transactions = result.data.filter(transaction => !synchronizedTransactionIds.includes(transaction.id));

        if (DRY) {
          logger.info(`Found ${transactions.length} pending transactions...`);
          logger.debug(JSON.stringify(transactions, null, 2));
        } else {
          logger.info(`Syncing ${transactions.length} pending transactions...`);
          await Promise.all(transactions.map(transaction => processTransaction(transaction)));

          logger.info(`Refreshing card details'...`);
          const stripeCard = await stripe.issuing.cards.retrieve(card.id);
          await card.update({
            spendingLimitAmount: stripeCard['spending_controls']['spending_limits'][0]['amount'],
            spendingLimitInterval: stripeCard['spending_controls']['spending_limits'][0]['interval'].toUpperCase(),
            data: omit(stripeCard, ['number', 'cvc', 'exp_year', 'exp_month']),
          });
        }
      } else {
        logger.warn(`\nUnsupported provider ${card.provider} for card ${card.id}.`);
      }
    } catch (error) {
      logger.error(`Error while syncing card ${card.id}`, error);
      reportErrorToSentry(error);
    }
  }
}

async function run() {
  logger.info('Reconciling Privacy and Stripe credit card transactions...');
  if (DRY) {
    logger.warn(`Running DRY, no changes to the DB`);
  }

  const connectedAccounts = await models.ConnectedAccount.findAll({
    where: { service: ConnectedAccountServices.STRIPE },
    include: [
      {
        model: models.Collective,
        as: 'collective',
        required: true,
        include: [
          {
            model: models.VirtualCard,
            as: 'virtualCards',
            required: true,
          },
        ],
      },
    ],
  });
  logger.info(`Found ${connectedAccounts.length} connected Stripe accounts...`);

  for (const connectedAccount of connectedAccounts) {
    await reconcileConnectedAccount(connectedAccount).catch(error => {
      console.error(error);
      reportErrorToSentry(error);
    });
  }
}

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      reportErrorToSentry(e);
      process.exit(1);
    });
}
