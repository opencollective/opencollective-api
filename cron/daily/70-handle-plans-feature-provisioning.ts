import '../../server/env';

import moment from 'moment';

import logger from '../../server/lib/logger';
import { reportErrorToSentry } from '../../server/lib/sentry';
import sequelize from '../../server/lib/sequelize';
import models, { Op } from '../../server/models';
import { runCronJob } from '../utils';

/**
 * Processes subscriptions that have PENDING status and whose start date has arrived, both
 * for new subscriptions and for replaced subscriptions.
 */
const processNewSubscriptions = async () => {
  // Find all subscriptions that need provisioning
  const today = moment.utc().startOf('day').toDate();
  const pendingSubscriptions = await models.PlatformSubscription.findAll({
    order: [['id', 'ASC']],
    include: [{ association: 'collective', required: true }],
    where: {
      featureProvisioningStatus: 'PENDING',
      period: { [Op.contains]: today }, // Only process subscriptions whose start date has arrived
    },
  });

  if (!pendingSubscriptions.length) {
    logger.info('No pending subscriptions to provision.');
    return [];
  }

  logger.info(`Found ${pendingSubscriptions.length} subscriptions to provision.`);

  const processedIds: number[] = [];
  for (const subscription of pendingSubscriptions) {
    try {
      const collective = subscription.collective;
      logger.info(`Processing subscription ${subscription.id} for collective ${collective.slug}`);

      await sequelize.transaction(async transaction => {
        // Find the previous subscription that ended when this one started
        const previousSubscription = await models.PlatformSubscription.findOne({
          transaction,
          order: [[sequelize.literal('upper(period)'), 'DESC']],
          where: {
            CollectiveId: collective.id,
            featureProvisioningStatus: 'PROVISIONED',
            id: { [Op.ne]: subscription.id },
          },
        });

        // Provision feature changes
        await models.PlatformSubscription.provisionFeatureChanges(collective, previousSubscription, subscription, {
          transaction,
        });
      });

      processedIds.push(subscription.id);
      logger.info(`Successfully provisioned subscription ${subscription.id}`);
    } catch (error) {
      logger.error(`Error provisioning platform subscription ${subscription.id}: ${error.message}`);
      reportErrorToSentry(error, {
        severity: 'error',
        extra: {
          subscriptionId: subscription.id,
          collectiveId: subscription.CollectiveId,
        },
      });
    }
  }
  return processedIds;
};

/**
 * To run after `processNewSubscriptions`. Handles the leftover subscriptions that have ended
 * without being replaced.
 */
const processEndedSubscriptions = async () => {
  const today = moment.utc().startOf('day').toDate();
  const processedIds: number[] = [];

  // Also handle deprovisioning of subscriptions that have ended without replacement
  const endedSubscriptions = await models.PlatformSubscription.findAll({
    include: [{ association: 'collective', required: true }],
    where: {
      featureProvisioningStatus: 'PROVISIONED',
      period: sequelize.literal(`upper(period) < NOW()`),
    },
  });

  for (const endedSubscription of endedSubscriptions) {
    try {
      const collective = endedSubscription.collective;

      // Check if there's a newer subscription for this collective
      await sequelize.transaction(async transaction => {
        const newerSubscription = await models.PlatformSubscription.findOne({
          where: { CollectiveId: collective.id, period: { [Op.contains]: today } },
        });

        // Only deprovision if there's no replacement subscription
        if (!newerSubscription) {
          logger.info(
            `Deprovisioning ended subscription ${endedSubscription.id} for collective ${collective.slug} (no replacement)`,
          );
          await models.PlatformSubscription.provisionFeatureChanges(collective, endedSubscription, null, {
            transaction,
          });
          processedIds.push(endedSubscription.id);
        }
      });
    } catch (error) {
      logger.error(`Error deprovisioning subscription ${endedSubscription.id}: ${error.message}`);
      reportErrorToSentry(error, {
        severity: 'error',
        extra: {
          subscriptionId: endedSubscription.id,
          collectiveId: endedSubscription.CollectiveId,
        },
      });
    }
  }
  return processedIds;
};

/**
 * This cron job handles the provisioning and deprovisioning of features when
 * platform subscription plans change.

 */
export async function runPlansFeatureProvisioningCron() {
  logger.info('Starting plans feature provisioning cron...');
  const newSubscriptionIds = await processNewSubscriptions();
  const endedSubscriptionIds = await processEndedSubscriptions();
  const processedIds = [...newSubscriptionIds, ...endedSubscriptionIds];
  logger.info(`Processed ${processedIds.length} subscriptions.`);
  return processedIds;
}

if (require.main === module) {
  runCronJob('plans-feature-provisioning', runPlansFeatureProvisioningCron, 10 * 60);
}
