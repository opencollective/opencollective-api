import '../../server/env';

import config from 'config';
import moment from 'moment';

import ActivityTypes from '../../server/constants/activities';
import ExpenseStatus from '../../server/constants/expense-status';
import ExpenseType from '../../server/constants/expense-type';
import logger from '../../server/lib/logger';
import { notify } from '../../server/lib/notifications/email';
import { reportErrorToSentry } from '../../server/lib/sentry';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Collective, Expense, Op } from '../../server/models';
import { Billing } from '../../server/models/PlatformSubscription';
import { onlyExecuteInProdOnMondays, runCronJob } from '../utils';

if (parseToBoolean(process.env.SKIP_OVERDUE_BILLING_NOTIFICATIONS)) {
  console.log('Skipping because SKIP_OVERDUE_BILLING_NOTIFICATIONS is set.');
  process.exit();
} else if (config.env === 'production' && new Date().getDate() % 8 !== 0) {
  console.log('OC_ENV is production and today is not a Monday, script aborted!');
  process.exit();
}

/**
 * Find all organizations with overdue platform billing expenses
 * An expense is considered overdue if:
 * - It's a PLATFORM_BILLING expense
 * - Status is not PAID
 * - Due date has passed
 */
async function getOrganizationsWithOverduePayments(): Promise<
  {
    collective: Collective;
    expenses: {
      expense: Expense;
      bill: Billing;
      amount: number;
      dueDate: Date | null;
    }[];
    totalAmount: number;
  }[]
> {
  // Find all unpaid platform billing expenses where the due date has passed
  const overdueExpenses = await models.Expense.findAll({
    where: {
      createdAt: { [Op.lte]: moment().subtract(7, 'days').toDate() },
      type: ExpenseType.PLATFORM_BILLING,
      status: [ExpenseStatus.APPROVED, ExpenseStatus.PENDING, ExpenseStatus.INCOMPLETE],
    },
    include: [{ association: 'collective', required: true }],
    order: [
      ['CollectiveId', 'ASC'],
      ['createdAt', 'DESC'],
    ],
  });

  // Group by collective and collect ALL overdue expenses for each organization
  const organizationsWithOverduePayments = new Map();

  for (const expense of overdueExpenses) {
    const collectiveId = expense.CollectiveId;
    if (!organizationsWithOverduePayments.has(collectiveId)) {
      organizationsWithOverduePayments.set(collectiveId, {
        collective: expense.collective,
        expenses: [],
        totalAmount: 0,
      });
    }

    const orgData = organizationsWithOverduePayments.get(collectiveId);
    orgData.expenses.push({
      expense,
      bill: expense.data?.bill,
      amount: expense.amount,
      dueDate: moment(expense.data?.bill?.dueDate || new Date()).toDate(),
    });
    orgData.totalAmount += expense.amount;
  }

  return Array.from(organizationsWithOverduePayments.values());
}

/**
 * Check if we've already sent an overdue notification for any of these expenses recently
 * We only want to send one notification per week per organization
 */
async function hasRecentOverdueNotification(collectiveId: number): Promise<boolean> {
  const recentActivity = await models.Activity.findOne({
    attributes: ['id'],
    where: {
      type: ActivityTypes.PLATFORM_BILLING_OVERDUE_REMINDER,
      CollectiveId: collectiveId,
      createdAt: {
        [Op.gte]: moment().subtract(6, 'days').toDate(),
      },
    },
  });

  return Boolean(recentActivity);
}

/**
 * Send overdue payment notification to organization admins
 */
async function sendOverdueNotification(organizationData: {
  collective: Collective;
  expenses: {
    expense: Expense;
    bill: Billing;
    amount: number;
    dueDate: Date | null;
  }[];
  totalAmount: number;
}): Promise<void> {
  const { collective, expenses, totalAmount } = organizationData;

  logger.info(
    `Sending overdue payment notification for ${collective.name} (#${collective.id}) with ${expenses.length} overdue expenses`,
  );

  try {
    // Create activity to track that we sent this notification
    const activity = await models.Activity.create({
      type: ActivityTypes.PLATFORM_BILLING_OVERDUE_REMINDER,
      UserId: null, // System activity
      CollectiveId: collective.id,
      data: {
        collective: collective.info,
        expenses: expenses.map(e => ({
          id: e.expense.id,
          amount: e.amount,
          status: e.expense.status,
          dueDate: e.dueDate,
        })),
        totalAmount,
        currency: 'USD',
      },
    });

    await notify.collective(activity);
    logger.info(`Successfully sent overdue notifications for ${collective.name}`);
  } catch (error) {
    logger.error(`Error sending overdue notification for ${collective.name}:`, error);
    throw error;
  }
}

export async function run(): Promise<void> {
  logger.info('Starting job to send platform billing overdue notifications');

  const organizationsWithOverduePayments = await getOrganizationsWithOverduePayments();

  logger.info(`Found ${organizationsWithOverduePayments.length} organizations with overdue payments`);

  let notificationsSent = 0;
  let notificationsSkipped = 0;

  for (const organizationData of organizationsWithOverduePayments) {
    const { collective } = organizationData;

    try {
      // Check if we've already sent a notification for this organization recently
      const hasRecentNotification = await hasRecentOverdueNotification(collective.id);
      if (hasRecentNotification) {
        logger.info(`Skipping notification for ${collective.name} - already sent recently`);
        notificationsSkipped++;
        continue;
      }

      await sendOverdueNotification(organizationData);
      notificationsSent++;
    } catch (error) {
      reportErrorToSentry(error, {
        severity: 'error',
        extra: { collectiveId: collective.id, collectiveName: collective.name },
      });
      // Continue with other organizations even if one fails
    }
  }

  logger.info(`Overdue notifications job completed. Sent: ${notificationsSent}, Skipped: ${notificationsSkipped}`);
}

if (require.main === module) {
  // Only run on Mondays in production (since Heroku scheduler only has daily/hourly options)
  onlyExecuteInProdOnMondays();

  runCronJob('send-platform-billing-overdue-notifications', run, 60 * 10); // 10 minutes timeout
}
