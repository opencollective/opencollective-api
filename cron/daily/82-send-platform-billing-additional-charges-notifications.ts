import '../../server/env';

import ActivityTypes from '../../server/constants/activities';
import logger from '../../server/lib/logger';
import { notify } from '../../server/lib/notifications/email';
import models, { Collective, Op } from '../../server/models';
import PlatformSubscription, { Billing } from '../../server/models/PlatformSubscription';
import { runCronJob } from '../utils';

const DRY_RUN = process.env.DRY_RUN;

if (DRY_RUN) {
  logger.warn('Running in DRY_RUN mode, no emails will be sent');
}

export async function run(): Promise<void> {
  logger.info('Starting platform billing additional charges notifications...');

  try {
    const organizationsWithFirstTimeAdditionalCharges = await getOrganizationsWithFirstTimeAdditionalCharges();
    logger.info(
      `Found ${organizationsWithFirstTimeAdditionalCharges.length} organizations with first-time additional charges`,
    );

    for (const orgData of organizationsWithFirstTimeAdditionalCharges) {
      try {
        await sendAdditionalChargesNotification(orgData);
      } catch (error) {
        logger.error(
          `Error sending additional charges notification to ${orgData.collective.name} (#${orgData.collective.id}): ${error.message}`,
        );
      }
    }

    logger.info('Platform billing additional charges notifications completed');
  } catch (error) {
    logger.error(`Error in platform billing additional charges notifications: ${error.message}`);
    throw error;
  }
}

/**
 * Find all organizations that have incurred additional charges for the first time for a given subscription.
 * This means:
 * 1. They have a current platform subscription with additional charges > 0 for the current billing period
 * 2. They have NEVER been notified about additional charges before (no previous activity)
 */
async function getOrganizationsWithFirstTimeAdditionalCharges(): Promise<
  {
    collective: Collective;
    currentUtilization: Billing['utilization'];
    currentSubscription: PlatformSubscription;
  }[]
> {
  const currentBillingPeriod = PlatformSubscription.currentBillingPeriod();
  logger.info(
    `Checking for additional charges in billing period: ${currentBillingPeriod.year}-${currentBillingPeriod.month + 1}`,
  );

  const subscriptions = await models.PlatformSubscription.findAll({
    where: {
      period: {
        [Op.overlap]: PlatformSubscription.getBillingPeriodRange(currentBillingPeriod),
      },
    },
    include: [
      {
        association: 'collective',
        required: true,
      },
    ],
  });

  logger.info(`Found ${subscriptions.length} collectives with current platform subscriptions`);

  const firstTimeOrganizations = [];

  // Check each subscription to see if it has additional charges for the first time
  for (const subscription of subscriptions) {
    const collective = subscription.collective;

    try {
      const currentBilling = await PlatformSubscription.calculateBilling(collective.id, currentBillingPeriod);
      if (currentBilling.additional.total <= 0) {
        logger.debug(`Organization ${collective.name} (#${collective.id}) has no additional charges, skipping`);
        continue;
      }

      // Check if this organization has ever been notified about additional charges for this subscription before
      const previousNotification = await models.Activity.findOne({
        where: {
          type: ActivityTypes.PLATFORM_BILLING_ADDITIONAL_CHARGES_NOTIFICATION,
          CollectiveId: collective.id,
          data: { subscription: { id: subscription.id } },
        },
      });

      // If no previous notification exists, this is their first time
      if (!previousNotification) {
        logger.info(`Organization ${collective.name} (#${collective.id}) has additional charges for the first time`);

        firstTimeOrganizations.push({
          collective,
          currentUtilization: currentBilling.utilization,
          currentSubscription: subscription,
        });
      } else {
        logger.debug(`Organization ${collective.name} (#${collective.id}) has been notified before, skipping`);
      }
    } catch (error) {
      logger.error(`Error calculating billing for ${collective.name} (#${collective.id}): ${error.message}`);
      continue;
    }
  }

  return firstTimeOrganizations;
}

/**
 * Send additional charges notification to all admins of an organization
 */
async function sendAdditionalChargesNotification({
  collective,
  currentUtilization,
  currentSubscription,
}: {
  collective: Collective;
  currentUtilization: Billing['utilization'];
  currentSubscription: PlatformSubscription;
}): Promise<void> {
  logger.info(`Sending additional charges notification to ${collective.name} (#${collective.id})`);

  // Create activity record to track that we've sent this notification
  if (!DRY_RUN) {
    const activity = await models.Activity.create({
      type: ActivityTypes.PLATFORM_BILLING_ADDITIONAL_CHARGES_NOTIFICATION,
      UserId: null, // System-generated
      CollectiveId: collective.id,
      HostCollectiveId: collective.HostCollectiveId,
      data: {
        collective: collective.info,
        currentUtilization,
        subscription: currentSubscription.info,
        notificationSentAt: new Date(),
      },
    });

    await notify.collective(activity);
  } else {
    logger.info(`[DRY_RUN] Would create activity record for ${collective.name} (#${collective.id})`);
  }
}

if (require.main === module) {
  runCronJob('send-platform-billing-additional-charges-notifications', run, 24 * 60 * 60);
}
