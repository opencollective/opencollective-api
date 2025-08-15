import '../../server/env';

import { Parser } from '@json2csv/plainjs';
import config from 'config';
import { compact, groupBy, sumBy } from 'lodash';
import moment from 'moment';

import activityType from '../../server/constants/activities';
import { SupportedCurrency } from '../../server/constants/currencies';
import expenseStatus from '../../server/constants/expense-status';
import expenseTypes from '../../server/constants/expense-type';
import { PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import PlatformConstants from '../../server/constants/platform';
import logger from '../../server/lib/logger';
import { parseToBoolean } from '../../server/lib/utils';
import models, {
  Collective,
  ConnectedAccount,
  Expense,
  Op,
  PaymentMethod,
  PlatformSubscription,
} from '../../server/models';
import { ExpenseStatus, ExpenseType } from '../../server/models/Expense';
import PayoutMethod, { PayoutMethodTypes } from '../../server/models/PayoutMethod';
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
} else if (parseToBoolean(process.env.SKIP_HOST_SETTLEMENT)) {
  console.log('Skipping because SKIP_HOST_SETTLEMENT is set.');
  process.exit();
}

if (DRY) {
  logger.warn('Running dry, changes are not going to be persisted to the DB.');
}

// return last payout method used for the last paid settlement if its was not manual or other.
async function getLastPaidSettlementManagedPayoutMethod(host): Promise<PayoutMethod> {
  const res = await Expense.findOne({
    where: {
      CollectiveId: host.id,
      type: ExpenseType.SETTLEMENT,
      status: ExpenseStatus.PAID,
    },
    attributes: [],
    include: [
      {
        model: PayoutMethod,
        attributes: ['type'],
        paranoid: false, // even if it was deleted at some point, we just want to know the type used
      },
      {
        model: PaymentMethod,
        as: 'paymentMethod',
        attributes: ['type'],
        paranoid: false, // even if it was deleted at some point, we just want to know the type used
      },
    ],
    order: [['createdAt', 'desc']],
  });

  if (!res) {
    return null;
  }

  if (
    !res['paymentMethod'] || // manual
    res['paymentMethod'].type === PAYMENT_METHOD_TYPE.MANUAL || // manual
    res.PayoutMethod?.type === PayoutMethodTypes.OTHER
  ) {
    // ignore other payout method here to try automated payout methods again
    // specially now that we support Stripe
    return null;
  }

  return res.PayoutMethod;
}

function isValidHostPayoutMethodType(
  host: Collective,
  hostConnectedAccounts: ConnectedAccount[],
  payoutMethodType: PayoutMethodTypes,
): boolean {
  switch (payoutMethodType) {
    case PayoutMethodTypes.PAYPAL: {
      if (hostConnectedAccounts?.find(c => c.service === 'paypal') && !host.settings?.['disablePaypalPayouts']) {
        return true;
      }
      break;
    }
    case PayoutMethodTypes.BANK_ACCOUNT: {
      if (hostConnectedAccounts?.find(c => c.service === 'transferwise')) {
        return true;
      }
      break;
    }

    case PayoutMethodTypes.OTHER:
    case PayoutMethodTypes.STRIPE: {
      return true;
    }
  }

  return false;
}

export async function run(baseDate: Date | moment.Moment = defaultDate): Promise<void> {
  const momentDate = moment(baseDate);
  const billingPeriodDate = moment(momentDate).subtract(1, 'months');
  const year = momentDate.year();
  const month = momentDate.month();
  logger.info(`Submitting platform subscription bills for ${billingPeriodDate.format('MMMM')}...`);

  const payoutMethods = groupBy(
    await models.PayoutMethod.findAll({
      where: { CollectiveId: PlatformConstants.PlatformCollectiveId, isSaved: true },
    }),
    'type',
  );
  const settlementBankAccountPayoutMethod = payoutMethods[PayoutMethodTypes.BANK_ACCOUNT].find(
    pm => pm.data?.['currency'] === 'USD',
  );

  // TODO: We need to paginate this to support long term growth
  const activeSubscriptionsByOrg = groupBy(
    await PlatformSubscription.getSubscriptionsInBillingPeriod({
      billingPeriod: { year, month },
      include: [{ model: Collective, as: 'collective', required: true }],
      order: [['id', 'ASC']],
    }),
    'CollectiveId',
  );

  const orgIds = Object.keys(activeSubscriptionsByOrg);
  for (const orgId of orgIds) {
    const activeSubscriptions = activeSubscriptionsByOrg[orgId];
    const organization = activeSubscriptions[0]?.collective;
    logger.info(`Processing subscriptions for organization ${organization.name} #${organization.id}`);

    const bill = await PlatformSubscription.calculateBilling(organization.id, { year, month });
    // Check if we already billed this organization for the current billing period
    const existingExpense = await models.Expense.findOne({
      where: {
        CollectiveId: organization.id,
        type: expenseTypes.SETTLEMENT,
        incurredAt: {
          [Op.gte]: billingPeriodDate.startOf('month').toDate(),
        },
        data: { bill: { billingPeriod: bill.billingPeriod } },
      },
    });
    if (existingExpense) {
      logger.info(
        `Organization ${organization.name} #${organization.id} has already been billed for this period, skipping...`,
      );
      continue;
    }

    const currency = 'USD' as SupportedCurrency;
    const incurredAt = moment.utc(bill.billingPeriod).toDate();
    let items = compact([
      // TODO: We should have separated items for the current subscription + any possible pro-rated subscriptions
      {
        description: 'Base Subscription Amount',
        amount: bill.baseAmount,
        incurredAt,
        currency,
      },
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

    const totalAmountCharged = sumBy(items, 'amount');
    // Ignore bills for $0
    if (totalAmountCharged === 0) {
      continue;
    }

    const connectedAccounts = await organization.getConnectedAccounts({
      where: { deletedAt: null },
    });

    const lastPayoutMethod = await getLastPaidSettlementManagedPayoutMethod(organization);
    const payoutMethod = [
      lastPayoutMethod?.type,
      PayoutMethodTypes.STRIPE,
      PayoutMethodTypes.BANK_ACCOUNT,
      PayoutMethodTypes.PAYPAL,
      PayoutMethodTypes.OTHER,
    ]
      .filter(Boolean)
      .filter(type => isValidHostPayoutMethodType(organization, connectedAccounts, type))
      .map(type => {
        if (type === lastPayoutMethod?.type && payoutMethods[type]?.some(pm => pm.id === lastPayoutMethod.id)) {
          return lastPayoutMethod;
        }

        if (type === PayoutMethodTypes.BANK_ACCOUNT) {
          return settlementBankAccountPayoutMethod;
        }
        return payoutMethods[type]?.[0];
      })
      .find(Boolean);

    if (!payoutMethod) {
      throw new Error('No Payout Method found, Open Collective Inc. needs to have at least one payout method.');
    }

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
      // isPlatformTipSettlement is deprecated but we keep it for now, we should rely on type=SETTLEMENT
      data: { bill },
      type: expenseTypes.SETTLEMENT,
      status: expenseStatus.PENDING,
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
      await expense.createActivity(activityType.COLLECTIVE_EXPENSE_CREATED, platformUser);
    }
  }
}

if (require.main === module) {
  runCronJob('submit-platform-subscription-bills', () => run(defaultDate), 23 * 60 * 60);
}
