import '../../server/env';

import { Parser } from '@json2csv/plainjs';
import config from 'config';
import { compact, groupBy, sumBy } from 'lodash';
import moment from 'moment';

import activityType from '../../server/constants/activities';
import { SupportedCurrency } from '../../server/constants/currencies';
import expenseStatus from '../../server/constants/expense-status';
import expenseTypes from '../../server/constants/expense-type';
import PlatformConstants from '../../server/constants/platform';
import logger from '../../server/lib/logger';
import { notify } from '../../server/lib/notifications/email';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Collective, Op, PlatformSubscription, sequelize } from '../../server/models';
import PayoutMethod, { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { Billing } from '../../server/models/PlatformSubscription';
import { runCronJob } from '../utils';

const json2csv = (data, opts = undefined) => new Parser(opts).parse(data);

const today = moment.utc();

const defaultDate = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();

const DRY = process.env.DRY;
const isProduction = config.env === 'production';

// Only run on the 1th of the month
if (isProduction && new Date().getDate() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the 1st of month, script aborted!');
  process.exit();
} else if (parseToBoolean(process.env.SKIP_PLATFORM_BILLING)) {
  console.log('Skipping because SKIP_PLATFORM_BILLING is set.');
  process.exit();
}

if (DRY) {
  logger.warn('Running dry, changes are not going to be persisted to the DB.');
}

export async function run(baseDate: Date | moment.Moment = defaultDate): Promise<void> {
  const momentDate = moment(baseDate);
  const billingPeriodDate = moment(momentDate).subtract(1, 'months');
  const year = billingPeriodDate.year();
  const month = billingPeriodDate.month();
  logger.info(`Submitting platform subscription bills for ${billingPeriodDate.format('MMMM/YYYY')}...`);

  const payoutMethods = groupBy(
    await models.PayoutMethod.findAll({
      where: { CollectiveId: PlatformConstants.PlatformCollectiveId, isSaved: true },
    }),
    'type',
  ) as Record<PayoutMethodTypes, PayoutMethod[]>;
  const settlementBankAccountPayoutMethod = payoutMethods[PayoutMethodTypes.BANK_ACCOUNT].find(
    pm => pm.data?.['currency'] === 'USD',
  );

  const distinctActiveSubscriptionsByCollectiveId = await PlatformSubscription.findAll({
    where: {
      period: {
        [Op.overlap]: PlatformSubscription.getBillingPeriodRange({ year, month }),
      },
    },
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('CollectiveId')), 'CollectiveId']],
    order: [['CollectiveId', 'ASC']],
    raw: true,
  });
  logger.info(`Found ${distinctActiveSubscriptionsByCollectiveId.length} active subscribers...`);

  const currency = 'USD' as SupportedCurrency;
  for (let i = 0; i < distinctActiveSubscriptionsByCollectiveId.length; i++) {
    const logPrefix = `[${i + 1}/${distinctActiveSubscriptionsByCollectiveId.length}]`;
    const subscription = distinctActiveSubscriptionsByCollectiveId[i];
    const orgId = subscription.CollectiveId;
    try {
      const organization: Collective = await models.Collective.findByPk(orgId);
      logger.info(`${logPrefix} Processing subscriptions for organization ${organization.name} #${organization.id}`);
      const bill = await PlatformSubscription.calculateBilling(organization.id, { year, month });
      // Ignore bills for $0
      if (bill.totalAmount === 0) {
        logger.info(`${logPrefix} Ignoring $0 bill for organization ${organization.name} #${organization.id}`);
        continue;
      } else {
        logger.info(
          `${logPrefix} Processing bill for organization ${organization.name} #${organization.id} total: \$${bill.totalAmount / 100}`,
        );
      }

      // Check if we already billed this organization for the current billing period
      const existingExpense = await models.Expense.findOne({
        where: {
          CollectiveId: organization.id,
          type: expenseTypes.PLATFORM_BILLING,
          createdAt: {
            [Op.gte]: moment(billingPeriodDate).subtract(2, 'month').toDate(),
          },
          data: { bill: { billingPeriod: bill.billingPeriod } },
        },
      });
      if (existingExpense) {
        logger.info(
          `${logPrefix} Organization ${organization.name} #${organization.id} has already been billed for this period, skipping...`,
        );
        continue;
      }

      function subscriptionBaseItemDescription(sub: Billing['base']['subscriptions'][number]) {
        const startDate = moment.utc(sub.startDate).format('DD-MMM-YYYY');
        const endDate = moment.utc(sub.endDate).format('DD-MMM-YYYY');
        return `Base subscription ${sub.title} - ${startDate} to ${endDate}`;
      }

      const incurredAt = moment.utc(bill.billingPeriod).toDate();
      let items = compact([
        ...bill.base.subscriptions
          .filter(sub => sub.amount > 0)
          .map(sub => ({
            description: subscriptionBaseItemDescription(sub),
            amount: sub.amount,
            incurredAt: sub.endDate,
            currency,
          })),
        bill.additional.utilization.activeCollectives > 0 && {
          description: `Additional Active Collective Utilization: ${bill.additional.utilization.activeCollectives}`,
          amount: bill.additional.amounts.activeCollectives,
          incurredAt,
          currency,
        },
        bill.additional.utilization.expensesPaid > 0 && {
          description: `Additional Paid Expenses Utilization: ${bill.additional.utilization.expensesPaid}`,
          amount: bill.additional.amounts.expensesPaid,
          incurredAt,
          currency,
        },
      ]);

      const payoutMethod = await PlatformSubscription.getPreferredPlatformPayout(
        organization,
        payoutMethods,
        settlementBankAccountPayoutMethod,
      );

      if (!payoutMethod) {
        throw new Error('No Payout Method found, Open Collective Inc. needs to have at least one payout method.');
      }

      const totalAmountCharged = sumBy(items, 'amount');
      const expenseData = {
        FromCollectiveId: PlatformConstants.PlatformCollectiveId,
        lastEditedById: PlatformConstants.PlatformUserId,
        UserId: PlatformConstants.PlatformUserId,
        payeeLocation: {
          address: PlatformConstants.PlatformAddress,
          country: PlatformConstants.PlatformCountry,
        },
        PayoutMethodId: payoutMethod.id,
        amount: totalAmountCharged,
        CollectiveId: organization.id,
        currency: 'USD' as SupportedCurrency,
        description: `Platform subscription payment for ${billingPeriodDate.format('MMMM, YYYY')}`,
        incurredAt: today.toDate(),
        data: { bill },
        type: expenseTypes.PLATFORM_BILLING,
        status: expenseStatus.APPROVED,
      };

      if (DRY) {
        console.debug(`Expense:\n${JSON.stringify(expenseData, null, 2)}`);
        console.debug(`PayoutMethod: ${payoutMethod.id} - ${payoutMethod.type}`);
        console.debug(`Items:\n${json2csv(items)}\n`);
      } else {
        // Create the Expense
        const expense = await models.Expense.create(expenseData);
        // Create Expense Items
        items = items.map(i => ({
          ...i,
          ExpenseId: expense.id,
          CreatedByUserId: PlatformConstants.PlatformUserId,
        }));
        await models.ExpenseItem.bulkCreate(items);

        const platformUser = await models.User.findByPk(PlatformConstants.PlatformUserId);
        const newExpenseActivity = await expense.createActivity(activityType.COLLECTIVE_EXPENSE_CREATED, platformUser, {
          notify: false,
        });

        try {
          await PlatformSubscription.chargeExpense(expense);
        } catch (err) {
          logger.error(`Error while charging platform expense #${expense.id} to #${orgId}: ${err.message}`);
          await notify.collective(newExpenseActivity, {
            template: 'platform.billing.new.expense',
          });
        }
      }
    } catch (e) {
      logger.error(
        `Error occurred while submitting organization  platform subscription bill to #${orgId}: ${e.message}`,
      );
    }
  }
}

if (require.main === module) {
  runCronJob('submit-platform-subscription-bills', () => run(defaultDate), 23 * 60 * 60);
}
