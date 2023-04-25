#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import { omit } from 'lodash';
import moment from 'moment';
import Stripe from 'stripe';

import { Service as ConnectedAccountServices } from '../../server/constants/connected_account';
import logger from '../../server/lib/logger';
import * as privacyLib from '../../server/lib/privacy';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models, { Op } from '../../server/models';
import privacy from '../../server/paymentProviders/privacy';
import { processTransaction } from '../../server/paymentProviders/stripe/virtual-cards';
import { PrivacyVirtualCardLimitIntervalToOCInterval } from '../../server/types/privacy';

const DRY = process.env.DRY;

async function reconcileConnectedAccount(connectedAccount) {
  const host = connectedAccount.collective;
  const cards = host.virtualCards.filter(card => card.provider === connectedAccount.service.toUpperCase());

  logger.info(`Found ${cards.length} cards connected to host #${connectedAccount.CollectiveId} ${host.slug}...`);

  for (const card of cards) {
    try {
      if (card.provider === 'PRIVACY') {
        const lastSyncedTransaction = await models.Expense.findOne({
          where: { VirtualCardId: card.id },
          order: [['createdAt', 'desc']],
        });

        const begin = lastSyncedTransaction
          ? moment(lastSyncedTransaction.createdAt).add(1, 'second').toISOString()
          : moment(card.createdAt).toISOString();

        logger.info(`\nReconciling card ${card.id}: fetching PRIVACY transactions since ${begin}`);

        const { data: transactions } = await privacyLib.listTransactions(
          connectedAccount.token,
          card.id,
          {
            begin,
            // Assumption: We won't have more than 200 transactions out of sync.
            // eslint-disable-next-line camelcase
            page_size: 200,
          },
          'approvals',
        );

        if (DRY) {
          logger.info(`Found ${transactions.length} pending transactions...`);
          logger.debug(JSON.stringify(transactions, null, 2));
        } else {
          logger.info(`Syncing ${transactions.length} pending transactions...`);
          await Promise.all(
            transactions.map(transaction => privacy.processTransaction(transaction, undefined, { card })),
          );

          logger.info(`Refreshing card details'...`);
          const [privacyCard] = await privacyLib.listCards(connectedAccount.token, card.id);
          if (!privacyCard) {
            throw new Error(`Could not find card ${card.id}`);
          }
          if (privacyCard.state === 'CLOSED') {
            await card.destroy();
          } else {
            await card.update({
              spendingLimitAmount: privacyCard['spend_limit'] === 0 ? null : privacyCard['spend_limit'],
              spendingLimitInterval: PrivacyVirtualCardLimitIntervalToOCInterval[privacyCard['spend_limit_duration']],
              data: omit(privacyCard, ['pan', 'cvv', 'exp_year', 'exp_month']),
            });
          }
        }
      }

      if (card.provider === 'STRIPE') {
        logger.info(`\nReconciling card ${card.id}: fetching STRIPE transactions`);

        const synchronizedTransactionIds = await models.Expense.findAll({
          where: {
            VirtualCardId: card.id,
            status: 'PAID',
          },
        }).then(expenses =>
          expenses.map(expense => expense.data?.transactionId).filter(transactionId => !!transactionId),
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
          if (stripeCard.status === 'canceled' || stripeCard.deleted) {
            await card.destroy();
          } else {
            await card.update({
              spendingLimitAmount: stripeCard['spending_controls']['spending_limits'][0]['amount'],
              spendingLimitInterval: stripeCard['spending_controls']['spending_limits'][0]['interval'].toUpperCase(),
              data: omit(stripeCard, ['number', 'cvc', 'exp_year', 'exp_month']),
            });
          }
        }
      }
    } catch (error) {
      logger.error(`Error while syncing card ${card.id}`, error);
      reportErrorToSentry(error);
    }
  }
}

export async function run() {
  logger.info('Reconciling Privacy and Stripe credit card transactions...');
  if (DRY) {
    logger.warn(`Running DRY, no changes to the DB`);
  }

  const connectedAccounts = await models.ConnectedAccount.findAll({
    where: { service: { [Op.or]: [ConnectedAccountServices.PRIVACY, ConnectedAccountServices.STRIPE] } },
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
  logger.info(`Found ${connectedAccounts.length} connected Privacy and Stripe accounts...`);

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
