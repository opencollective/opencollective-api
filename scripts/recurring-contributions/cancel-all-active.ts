/**
 * A script to cancel all active recurring contributions for a collective.
 *
 * Marks orders as CANCELLED and flags them for async deactivation by the
 * `handle-batch-subscriptions-update` cron job (PayPal, Stripe, etc.).
 */

import '../../server/env';

import { Command } from 'commander';
import { Op } from 'sequelize';

import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import models, { Order } from '../../server/models';

type CancelAllActiveRecurringContributionsOptions = {
  isDryRun?: boolean;
  reason?: string;
  messageSource?: 'PLATFORM' | 'COLLECTIVE' | 'HOST';
  includeChildren?: boolean;
  silent?: boolean;
};

export const findActiveRecurringOrders = async (
  collectiveId: number,
  { includeChildren = true }: { includeChildren?: boolean } = {},
): Promise<Order[]> => {
  return models.Order.findAll({
    where: {
      status: { [Op.ne]: OrderStatuses.CANCELLED },
    },
    include: [
      {
        model: models.Subscription,
        required: true,
        where: { isActive: true },
      },
      {
        model: models.Collective,
        as: 'collective',
        required: true,
        where: {
          [Op.or]: [{ id: collectiveId }, ...(includeChildren ? [{ ParentCollectiveId: collectiveId }] : [])],
        },
      },
      { association: 'fromCollective' },
    ],
    order: [['id', 'ASC']],
  });
};

export const cancelAllActiveRecurringContributions = async (
  collectiveSlug: string,
  {
    isDryRun = process.env.DRY_RUN !== 'false',
    reason = 'Recurring contributions cancelled by admin script',
    messageSource = 'PLATFORM',
    includeChildren = true,
    silent = false,
  }: CancelAllActiveRecurringContributionsOptions = {},
): Promise<{ cancelledOrderIds: number[] }> => {
  const collective = await models.Collective.findBySlug(collectiveSlug, {}, false);
  if (!collective) {
    throw new Error(`Collective ${collectiveSlug} not found`);
  }

  const orders = await findActiveRecurringOrders(collective.id, { includeChildren });

  if (!orders.length) {
    logger.info(`No active recurring contributions found for collective ${collectiveSlug}`);
    return { cancelledOrderIds: [] };
  }

  logger.info(
    `Found ${orders.length} active recurring contribution(s) for collective ${collectiveSlug} (id: ${collective.id})`,
  );

  for (const order of orders) {
    logger.info(
      `  - Order #${order.id} from @${order.fromCollective.slug} (${order.currency} ${order.totalAmount / 100}/${order.Subscription.interval})`,
    );
  }

  if (isDryRun) {
    logger.info('Dry run mode enabled, exiting without making changes');
    return { cancelledOrderIds: [] };
  }

  await models.Order.stopActiveSubscriptions(collective.id, OrderStatuses.CANCELLED, {
    messageForContributors: reason,
    messageSource,
    includeChildren,
    paymentProviderAction: 'CANCEL',
    createActivity: !silent,
  });

  logger.info(`Cancelled ${orders.length} recurring contribution(s) for collective ${collectiveSlug}`);

  return { cancelledOrderIds: orders.map(order => order.id) };
};

const main = async (
  collectiveSlug: string,
  options: CancelAllActiveRecurringContributionsOptions = {},
): Promise<{ cancelledOrderIds: number[] }> => {
  return cancelAllActiveRecurringContributions(collectiveSlug, options);
};

if (require.main === module) {
  const program = new Command();
  program.showSuggestionAfterError();
  program.argument('<collectiveSlug>', 'Slug of the collective to cancel recurring contributions for');
  program.option('--reason <reason>', 'Message to send to contributors');
  program.option(
    '--message-source <messageSource>',
    'Source of the cancellation message (PLATFORM, COLLECTIVE, or HOST)',
    'PLATFORM',
  );
  program.option('--no-children', 'Only cancel contributions to the collective itself, not its children');
  program.option('--silent', 'Skip creating cancellation activities and contributor notifications');
  program.parse();

  const [collectiveSlug] = program.args;
  const options = program.opts();

  main(collectiveSlug, {
    reason: options.reason,
    messageSource: options.messageSource,
    includeChildren: options.children !== false,
    silent: options.silent,
  })
    .then(() => process.exit())
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
