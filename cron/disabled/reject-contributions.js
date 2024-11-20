import '../../server/env';

import { ArgumentParser } from 'argparse';
import { get, intersection } from 'lodash';

import { activities } from '../../server/constants';
import { MODERATION_CATEGORIES_ALIASES } from '../../server/constants/moderation-categories';
import orderStatus from '../../server/constants/order-status';
import { purgeCacheForCollective } from '../../server/lib/cache';
import logger from '../../server/lib/logger';
import { createRefundTransaction, findPaymentMethodProvider, refundTransaction } from '../../server/lib/payments';
import models, { Op, sequelize } from '../../server/models';
import { runCronJob } from '../utils';

// Fetch all orders potentially affected: contributor flagged AND recipient setup rejection

const query = `SELECT "Orders"."id"
  FROM "Orders", "Collectives", "Collectives" as "FromCollectives"
  WHERE "Orders"."CollectiveId" = "Collectives"."id" AND "FromCollectives"."id" = "Orders"."FromCollectiveId"
  AND "Orders"."status" IN ('ACTIVE', 'PAID')
  AND "Orders"."deletedAt" IS NULL
  AND "Collectives"."settings"->'moderation'->'rejectedCategories' IS NOT NULL
  AND jsonb_array_length("Collectives"."settings"->'moderation'->'rejectedCategories') > 0
  AND "FromCollectives"."data"->'categories' IS NOT NULL`;

const getContributorRejectedCategories = (fromCollective, collective) => {
  const rejectedCategories = get(collective, 'settings.moderation.rejectedCategories', []);
  const contributorCategories = get(fromCollective, 'data.categories', []);

  if (rejectedCategories.length === 0 || contributorCategories.length === 0) {
    return [];
  }

  // Example:
  // MODERATION_CATEGORIES_ALIASES = ['CASINO_GAMBLING': ['casino', 'gambling'], 'VPN_PROXY': ['vpn', 'proxy']]
  // - when contributorCategories = ['CASINO_GAMBLING'], returns ['CASINO_GAMBLING']
  // - when contributorCategories = ['vpn'] or ['proxy'], returns ['VPN_PROXY']
  const contributorRejectedCategories = Object.keys(MODERATION_CATEGORIES_ALIASES).filter(key => {
    return (
      contributorCategories.includes(key) ||
      intersection(MODERATION_CATEGORIES_ALIASES[key], contributorCategories).length !== 0
    );
  });

  return intersection(rejectedCategories, contributorRejectedCategories);
};

async function run({ dryRun, limit, force } = {}) {
  let rows = await sequelize.query(query, { type: sequelize.QueryTypes.SELECT });

  if (rows.length > 0 && limit) {
    rows = rows.slice(0, limit);
  }

  for (const row of rows) {
    const order = await models.Order.findByPk(row['id']);
    const collective = await models.Collective.findByPk(order.CollectiveId);
    const fromCollective = await models.Collective.findByPk(order.FromCollectiveId);

    if (collective.slug === 'opencollective') {
      continue;
    }

    logger.info(`Checking order #${order.id} from #${fromCollective.slug} to #${collective.slug}`);

    const rejectedCategories = getContributorRejectedCategories(fromCollective, collective);

    if (rejectedCategories.length === 0) {
      logger.info(`  - No rejected categories`);
      continue;
    }

    logger.info(`  - Found rejected categories: ${rejectedCategories.join(', ')}`);

    let shouldMarkAsRejected = true;
    let shouldNotifyContributor = true;
    let actionTaken = false;

    // Retrieve latest transaction
    const transaction = await models.Transaction.findOne({
      where: {
        OrderId: order.id,
        type: 'CREDIT',
        createdAt: { [Op.gte]: sequelize.literal("NOW() - INTERVAL '30 days'") },
      },
      order: [['createdAt', 'DESC']],
      include: [models.PaymentMethod],
    });

    if (transaction) {
      logger.info(`  - Found transaction #${transaction.id}`);
      // Refund transaction if not already refunded
      if (!transaction.RefundTransactionId) {
        logger.info(`  - Refunding transaction`);
        const paymentMethodProvider = transaction.PaymentMethod
          ? findPaymentMethodProvider(transaction.PaymentMethod)
          : null;
        if (!paymentMethodProvider || !paymentMethodProvider.refundTransaction) {
          if (force) {
            logger.info(`  - refundTransaction not available. Creating refundTransaction in the database only.`);
          } else {
            logger.info(`  - refundTransaction not available. Use 'force' to refundTransaction in the database only.`);
          }
        }
        if (!dryRun) {
          try {
            if (paymentMethodProvider.refundTransaction) {
              await refundTransaction(transaction, null, 'Contribution rejected');
            } else if (force) {
              await createRefundTransaction(transaction, 0, null);
            } else {
              if (order.status === 'PAID') {
                shouldMarkAsRejected = false;
                shouldNotifyContributor = false;
              }
            }
          } catch (e) {
            if (e.message.includes('has already been refunded')) {
              logger.info(`  - Transaction has already been refunded on Payment Provider`);
              if (paymentMethodProvider && paymentMethodProvider.refundTransactionOnlyInDatabase) {
                await paymentMethodProvider.refundTransactionOnlyInDatabase(transaction);
              }
            }
          }
          actionTaken = true;
        }
      } else {
        logger.info(`  - Transaction already refunded`);
      }
    } else {
      logger.info(`  - No transaction found`);
      if (order.status === 'PAID') {
        shouldMarkAsRejected = false;
        shouldNotifyContributor = false;
      }
    }

    // Mark the Order as rejected (only if we found a transaction to refund)
    if (shouldMarkAsRejected) {
      logger.info(`  - Marking order #${order.id} as rejected `);
      if (!dryRun) {
        await order.update({ status: orderStatus.REJECTED });
      }
      actionTaken = true;
    }

    // Deactivate subscription
    if (order.SubscriptionId) {
      const subscription = await models.Subscription.findByPk(order.SubscriptionId);
      if (subscription) {
        logger.info(`  - Deactivating subscription #${order.SubscriptionId}`);
        if (!dryRun) {
          await subscription.deactivate('Contribution rejected');
        }
        actionTaken = true;
      } else {
        logger.info(`  - Subscription not found`);
      }
    } else {
      logger.info(`  - No subscription to deactivate`);
    }

    // Remove memberships

    const membershipSearchParams = {
      where: {
        MemberCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        role: 'BACKER',
      },
    };
    const membership = await models.Member.findOne(membershipSearchParams);
    if (membership) {
      logger.info(`  - Deleting BACKER memberships`);
      if (!dryRun) {
        await models.Member.destroy(membershipSearchParams);
      }
      actionTaken = true;
    } else {
      logger.info(`  - No BACKER memberships to delete`);
    }

    if (actionTaken) {
      logger.info(`  - Purging cache for ${collective.slug}`);
      logger.info(`  - Purging cache for ${fromCollective.slug}`);
      if (!dryRun) {
        purgeCacheForCollective(collective.slug);
        purgeCacheForCollective(fromCollective.slug);
      }
    }

    if (shouldNotifyContributor) {
      const activity = {
        type: activities.CONTRIBUTION_REJECTED,
        OrderId: order.id,
        FromCollectiveId: fromCollective.id,
        CollectiveId: collective.id,
        HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
        data: {
          collective: collective.info,
          fromCollective: fromCollective.info,
          rejectionReason: `${collective.name} banned some specific categories of contributors and there was a match with your profile.`,
        },
      };
      logger.info(`  - Notifying admins of ${fromCollective.slug}`);
      if (!dryRun) {
        await models.Activity.create(activity);
      }
    }
  }
}

/* eslint-disable camelcase */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    add_help: true,
    description: 'Reject Contributions based on Categories',
  });
  parser.add_argument('--dryrun', {
    help: "Don't perform any change, just log.",
    default: false,
    action: 'store_const',
    const: true,
  });
  parser.add_argument('-l', '--limit', {
    help: 'Total matching orders to process',
  });
  parser.add_argument('--force', {
    help: "Force refunds even if payment provider doesn't support it.",
    default: false,
    action: 'store_const',
    const: true,
  });
  const args = parser.parse_args();
  return {
    dryRun: args.dryrun,
    limit: args.limit,
    force: args.force,
  };
}

/* eslint-enable camelcase */

if (require.main === module) {
  runCronJob('reject-contributions', () => run(parseCommandLineArguments()), 24 * 60 * 60);
}
