/**
 * This script can be used whenever PayPal webhooks event types change to update
 * Host's connected accounts.
 */

import '../../server/env';

import logger from '../../server/lib/logger';
import * as PaypalLib from '../../server/lib/paypal';
import models, { Op, sequelize } from '../../server/models';

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
  const ignoredSlugs = process.env.SKIP_SLUGS ? process.env.SKIP_SLUGS.split(',') : null;
  const onlySlugs = process.env.ONLY_SLUGS ? process.env.ONLY_SLUGS.split(',') : null;
  const filteredHosts = allHosts.filter(host => {
    return (!ignoredSlugs || !ignoredSlugs.includes(host.slug)) && (!onlySlugs || onlySlugs.includes(host.slug));
  });

  for (const host of filteredHosts) {
    logger.info(`Checking PayPal webhook for ${host.slug}...`);
    await PaypalLib.setupPaypalWebhookForHost(host);

    if (process.env.REMOVE_OTHERS) {
      await PaypalLib.removeUnusedPaypalWebhooks(host);
    }
  }

  return;
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
