import '../../server/env';

import { get } from 'lodash';
import moment from 'moment';

import ActivityTypes from '../../server/constants/activities';
import OrderStatuses from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Op } from '../../server/models';
import { runCronJob } from '../utils';

if (parseToBoolean(process.env.SKIP_RESUME_SUBSCRIPTION_EMAILS)) {
  console.log('Skipping because SKIP_RESUME_SUBSCRIPTION_EMAILS is set.');
  process.exit();
}

const NB_REMINDERS = 3;

/**
 * Will send the 1st reminder 5 days after the 1st email, then 12 days after the 2nd email, then 19 days after the 3rd email,
 * for a total of 3 reminders over 36 days.
 */
const getNextReminderDate = (reminder: number): Date => {
  if (reminder >= NB_REMINDERS) {
    return null;
  } else {
    const nbDays = reminder * 7 + 5;
    return moment().add(nbDays, 'day').toDate();
  }
};

export async function run() {
  logger.info('Starting job to send resume subscription emails');
  const orders = await models.Order.findAll({
    limit: 1000, // We don't want this job to be too heavy. Since it's hourly, we can delay some orders to the next run.
    order: [
      ['FromCollectiveId', 'ASC'], // Order by FromCollectiveId to send all emails to someone in a row (in case they have multiple subscriptions)
      ['id', 'ASC'],
    ],
    where: {
      status: OrderStatuses.PAUSED,
      SubscriptionId: { [Op.ne]: null },
      data: {
        needsAsyncDeactivation: { [Op.not]: true },
        pausedBy: {
          [Op.or]: [{ [Op.is]: null }, { [Op.notIn]: ['HOST', 'PLATFORM'] }],
        },
      },
      [Op.or]: [
        // Either we haven't sent any reminder yet
        { data: { resumeContribution: { reminder: { [Op.is]: null } } } },
        // Or we have sent reminders, but not enough and the next one is due
        {
          data: {
            resumeContribution: {
              reminder: { [Op.lte]: NB_REMINDERS },
              nextReminderDate: { [Op.lt]: new Date() },
            },
          },
        },
      ],
    },
    include: [
      { association: 'Subscription', required: true },
      { association: 'fromCollective', required: true },
      {
        association: 'collective',
        required: true,
        where: {
          isActive: true,
          data: { resumeContributionsStartedAt: { [Op.ne]: null } },
        },
      },
    ],
  });

  logger.info(`Found ${orders.length} subscriptions to send resume emails for`);
  for (const order of orders) {
    const reminder = order.data?.resumeContribution?.reminder || 0;
    const nextReminderDate = getNextReminderDate(reminder);

    // Send email
    logger.debug('Sending email');
    await models.Activity.create({
      type: ActivityTypes.SUBSCRIPTION_READY_TO_BE_RESUMED,
      FromCollectiveId: order.FromCollectiveId,
      CollectiveId: order.CollectiveId,
      OrderId: order.id,
      HostCollectiveId: order.collective.HostCollectiveId,
      data: {
        order: order.info,
        subscription: order.Subscription,
        fromCollective: order.fromCollective.minimal,
        collective: order.collective.minimal,
        awaitForDispatch: true,
        messageForContributors: get(order.collective, 'data.resumeContributionsMessage'),
        messageSource: 'COLLECTIVE',
        reminder,
        nbRemindersLeft: NB_REMINDERS - reminder,
      },
    });

    // Update order
    logger.debug('Updating order');
    await order.update({
      data: {
        ...order.data,
        resumeContribution: {
          ...order.data?.resumeContribution,
          reminder: reminder + 1,
          nextReminderDate,
        },
      },
    });
  }

  logger.info('Done!');
  return orders;
}

if (require.main === module) {
  runCronJob('send-resume-subscription-emails', run, 60 * 60);
}
