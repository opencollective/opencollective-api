/**
 * This script can be used whenever PayPal webhooks event types change to update
 * Host's connected accounts.
 */

import '../../server/env';

import { Command } from 'commander';

import logger from '../../server/lib/logger';
import * as PaypalLib from '../../server/lib/paypal';
import models, { Collective, Op, sequelize } from '../../server/models';

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

const getHostsFromArg = async (hostSlugsStr: string, ignoreSlugsStr: string): Promise<Collective[]> => {
  const strToSlugsList = str => str?.split(',')?.map(slug => slug.trim()) || [];
  const hostsSlugs = strToSlugsList(hostSlugsStr);
  const ignoredSlugs = strToSlugsList(ignoreSlugsStr);
  const allHosts = await getAllHostsWithPaypalAccounts();
  return allHosts.filter(host => {
    return !ignoredSlugs.includes(host.slug) && (!hostsSlugs.length || hostsSlugs.includes(host.slug));
  });
};

const checkWebhooks = async (args: string[], options): Promise<void> => {
  const filteredHosts = await getHostsFromArg(args[0], options.ignore);
  if (!filteredHosts.length) {
    console.log('No hosts found');
    return;
  }

  for (const host of filteredHosts) {
    logger.info(`Checking PayPal webhook for ${host.slug}...`);
    const result = await PaypalLib.listPaypalWebhooks(host);
    console.log(`PayPal webhooks for ${host.slug}:`, JSON.stringify(result, null, 2));
  }
};

const updateWebhooks = async (args: string[], options): Promise<void> => {
  const filteredHosts = await getHostsFromArg(args[0], options.ignore);
  if (!filteredHosts.length) {
    console.log('No hosts found');
    return;
  }

  for (const host of filteredHosts) {
    logger.info(`Checking PayPal webhook for ${host.slug}...`);
    await PaypalLib.setupPaypalWebhookForHost(host);

    if (process.env.REMOVE_OTHERS) {
      await PaypalLib.removeUnusedPaypalWebhooks(host);
    }
  }
};

const main = async (): Promise<void> => {
  const program = new Command();
  program.showSuggestionAfterError();

  // General options
  program
    .command('check [hostSlugs...]')
    .description('Check PayPal webhooks for hosts, or all hosts if none provided')
    .option('--ignore <slugs>', 'List of host slugs to ignore')
    .action(checkWebhooks);

  program
    .command('update [hostSlugs...]')
    .description('Update PayPal webhooks for hosts, or all hosts if none provided')
    .option('--ignore <slugs>', 'List of host slugs to ignore')
    .action(updateWebhooks);

  await program.parseAsync();
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
