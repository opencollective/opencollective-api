/**
 * This script can be used whenever PayPal webhooks event types change to update
 * Host's connected accounts.
 */

import '../server/env';

import logger from '../server/lib/logger';
import * as PaypalLib from '../server/lib/paypal';
import models, { Op, sequelize } from '../server/models';

const getAllHostsWithPaypalAccounts = () => {
  return models.Collective.findAll({
    where: { isHostAccount: true },
    group: [sequelize.col('Collective.id')],
    include: [
      {
        association: 'ConnectedAccounts',
        required: true,
        attributes: [],
        where: { service: 'paypal', clientId: { [Op.not]: null }, token: { [Op.not]: null } },
      },
    ],
  });
};

const main = async (): Promise<void> => {
  const allHosts = await getAllHostsWithPaypalAccounts();

  for (const host of allHosts) {
    logger.info(`Checking PayPal webhook for ${host.slug}...`);
    await PaypalLib.setupPaypalWebhookForHost(host);
  }

  return;
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
