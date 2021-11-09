#!/usr/bin/env node
import '../../server/env';

import moment from 'moment';

import { Service as ConnectedAccountServices } from '../../server/constants/connected_account';
import { getFxRate } from '../../server/lib/currency';
import logger from '../../server/lib/logger';
import * as privacyLib from '../../server/lib/privacy';
import models from '../../server/models';
import privacy from '../../server/paymentProviders/privacy';

const DRY = process.env.DRY;

async function reconcileConnectedAccount(connectedAccount) {
  const host = await models.Collective.findByPk(connectedAccount.CollectiveId);
  const cards = await models.VirtualCard.findAll({ where: { HostCollectiveId: host.id, provider: 'PRIVACY' } });
  logger.info(`Found ${cards.length} cards connected to host #${connectedAccount.CollectiveId} ${host.slug}...`);

  for (const card of cards) {
    try {
      const lastSyncedTransaction = await models.Expense.findOne({
        where: { VirtualCardId: card.id },
        order: [['createdAt', 'desc']],
      });
      const begin = lastSyncedTransaction
        ? moment(lastSyncedTransaction.createdAt).add(1, 'second').toISOString()
        : moment(card.createdAt).toISOString();
      logger.info(`\nReconciling card ${card.id}: fetching transactions since ${begin}`);

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
      const hostCurrencyFxRate = await getFxRate('USD', host.currency);

      if (DRY) {
        logger.info(`Found ${transactions.length} pending transactions...`);
        logger.debug(JSON.stringify(transactions, null, 2));
      } else {
        logger.info(`Syncing ${transactions.length} pending transactions...`);
        await Promise.all(
          transactions.map(transaction => privacy.processTransaction(transaction, { host, hostCurrencyFxRate })),
        );
        logger.info(`Refreshing card details'...`);
        await privacy.refreshCardDetails(card);
      }
    } catch (error) {
      logger.error(`Error while syncing card ${card.id}`, error);
    }
  }
}

export async function run() {
  logger.info('Reconciling Privacy.com Credit Card transactions...');
  if (DRY) {
    logger.warn(`Running DRY, no changes to the DB`);
  }

  const connectedAccounts = await models.ConnectedAccount.findAll({
    where: { service: ConnectedAccountServices.PRIVACY },
  });
  logger.info(`Found ${connectedAccounts.length} connected Privacy accounts...`);

  for (const connectedAccount of connectedAccounts) {
    await reconcileConnectedAccount(connectedAccount).catch(console.error);
  }
}

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
