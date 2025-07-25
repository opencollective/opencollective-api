import '../../server/env';

import { Parser } from '@json2csv/plainjs';
import config from 'config';
import { groupBy, sumBy } from 'lodash';
import moment from 'moment';

import activityType from '../../server/constants/activities';
import expenseStatus from '../../server/constants/expense-status';
import expenseTypes from '../../server/constants/expense-type';
import { PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import { getPlatformConstantsForDate, PLATFORM_MIGRATION_DATE } from '../../server/constants/platform';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { getTransactionsCsvUrl } from '../../server/lib/csv';
import { getFxRate } from '../../server/lib/currency';
import { getPendingHostFeeShare, getPendingPlatformTips } from '../../server/lib/host-metrics';
import { parseToBoolean } from '../../server/lib/utils';
import models, { Collective, ConnectedAccount, Expense, PaymentMethod, sequelize } from '../../server/models';
import { CommentType } from '../../server/models/Comment';
import { ExpenseStatus, ExpenseType } from '../../server/models/Expense';
import PayoutMethod, { PayoutMethodTypes } from '../../server/models/PayoutMethod';
import { runCronJob } from '../utils';

const json2csv = (data, opts = undefined) => new Parser(opts).parse(data);

const today = moment.utc();

const defaultDate = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();

const MIN_AMOUNT_USD = Number(config.settlement.minimumAmountInUSD);
const DRY = process.env.DRY;
const HOST_ID = process.env.HOST_ID;
const isProduction = config.env === 'production';
const KIND = process.env.KIND;
const { PLATFORM_TIP_DEBT, HOST_FEE_SHARE_DEBT } = TransactionKind;

// Only run on the 1th of the month
if (isProduction && new Date().getDate() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the 1st of month, script aborted!');
  process.exit();
} else if (parseToBoolean(process.env.SKIP_HOST_SETTLEMENT)) {
  console.log('Skipping because SKIP_HOST_SETTLEMENT is set.');
  process.exit();
}

if (DRY) {
  console.info('Running dry, changes are not going to be persisted to the DB.');
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
  const momentDate = moment(baseDate).subtract(1, 'month');
  const year = momentDate.year();
  const month = momentDate.month();
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 1);
  const PlatformConstants = getPlatformConstantsForDate(momentDate);

  console.info(`Invoicing hosts pending fees and tips for ${momentDate.format('MMMM')}.`);

  const payoutMethods = groupBy(
    await models.PayoutMethod.findAll({
      where: { CollectiveId: PlatformConstants.PlatformCollectiveId, isSaved: true },
    }),
    'type',
  );
  const settlementBankAccountPayoutMethod = payoutMethods[PayoutMethodTypes.BANK_ACCOUNT].find(
    pm => pm.data?.['currency'] === 'USD',
  );

  const hosts = await sequelize.query(
    `
      SELECT c.*
      FROM "Collectives" c
      INNER JOIN "Transactions" t ON t."HostCollectiveId" = c.id AND t."deletedAt" IS NULL
      WHERE c."isHostAccount" IS TRUE
      AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
      AND c.id NOT IN (:ignoreSettlementForIds) -- Make sure we don't invoice OC Inc as reverse settlements are not supported yet
      GROUP BY c.id
    `,
    {
      mapToModel: true,
      type: sequelize.QueryTypes.SELECT,
      model: models.Collective,
      replacements: {
        startDate: startDate,
        endDate: endDate,
        ignoreSettlementForIds: PlatformConstants.AllPlatformCollectiveIds,
      },
    },
  );

  let slugs, skipSlugs;
  if (process.env.SLUGS) {
    slugs = process.env.SLUGS.split(',').map(str => str.trim());
  }
  if (process.env.SKIP_SLUGS) {
    skipSlugs = process.env.SKIP_SLUGS.split(',').map(str => str.trim());
  }

  for (const host of hosts) {
    if (HOST_ID && host.id !== parseInt(HOST_ID)) {
      continue;
    }
    if (slugs && !slugs.includes(host.slug)) {
      continue;
    }
    if (skipSlugs && skipSlugs.includes(host.slug)) {
      continue;
    }

    let pendingPlatformTips, pendingHostFeeShare;
    if (!KIND || KIND === PLATFORM_TIP_DEBT) {
      pendingPlatformTips = await getPendingPlatformTips(host, { status: ['OWED'], endDate });
    }
    if (!KIND || KIND === HOST_FEE_SHARE_DEBT) {
      pendingHostFeeShare = await getPendingHostFeeShare(host, { status: ['OWED'], endDate });
    }

    const plan = await host.getPlan();

    let items = [];

    const transactionsKinds = KIND ? [KIND] : [PLATFORM_TIP_DEBT, HOST_FEE_SHARE_DEBT];

    const transactions = await sequelize.query(
      `
      SELECT t.*
      FROM "Transactions" as t
      INNER JOIN "TransactionSettlements" ts ON ts."TransactionGroup" = t."TransactionGroup" AND t.kind = ts.kind
      WHERE t."CollectiveId" = :CollectiveId
        AND t."kind" IN (:transactionsKinds)
        AND t."isDebt" IS TRUE
        AND t."deletedAt" IS NULL
        AND ts."status" = 'OWED'
        AND t."createdAt" < :endDate
      `,
      {
        replacements: { CollectiveId: host.id, endDate, transactionsKinds },
        model: models.Transaction,
        mapToModel: true, // pass true here if you have any mapped fields
      },
    );

    if (pendingPlatformTips) {
      items.push({
        incurredAt: new Date(),
        amount: pendingPlatformTips,
        currency: host.currency,
        description: 'Platform Tips',
      });
    }

    if (pendingHostFeeShare) {
      items.push({
        incurredAt: new Date(),
        amount: pendingHostFeeShare,
        currency: host.currency,
        description: 'Platform Share',
      });
    }

    if (plan.pricePerCollective && (!KIND || KIND === HOST_FEE_SHARE_DEBT)) {
      const activeHostedCollectives = await host.getHostedCollectivesCount();
      const amount = (activeHostedCollectives || 0) * plan.pricePerCollective;
      if (amount) {
        items.push({
          incurredAt: new Date(),
          amount,
          currency: host.currency,
          description: 'Fixed Fee per Hosted Collective',
        });
      }
    }

    const totalAmountCharged = sumBy(items, 'amount');
    const hostToPlatformFxRate = await getFxRate(host.currency, 'USD');
    const totalAmountChargedInUsd = totalAmountCharged * hostToPlatformFxRate;

    if (totalAmountChargedInUsd < MIN_AMOUNT_USD) {
      console.warn(
        `${host.name} (#${host.id}) skipped, total amount pending ${totalAmountChargedInUsd / 100} < $${MIN_AMOUNT_USD / 100}.\n`,
      );
      continue;
    }
    console.info(
      `${host.name} (#${host.id}) has ${transactions.length} pending transactions and owes ${
        totalAmountCharged / 100
      }${host.currency} (${totalAmountChargedInUsd / 100} USD)`,
    );

    const connectedAccounts = await host.getConnectedAccounts({
      where: { deletedAt: null },
    });

    const lastPayoutMethod = await getLastPaidSettlementManagedPayoutMethod(host);
    const payoutMethod = [
      lastPayoutMethod?.type,
      PayoutMethodTypes.STRIPE,
      PayoutMethodTypes.BANK_ACCOUNT,
      PayoutMethodTypes.PAYPAL,
      PayoutMethodTypes.OTHER,
    ]
      .filter(Boolean)
      .filter(type => isValidHostPayoutMethodType(host, connectedAccounts, type))
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

    let extraDescription = '';
    if (KIND === PLATFORM_TIP_DEBT) {
      extraDescription = ' (Platform Tips)';
    } else if (KIND === HOST_FEE_SHARE_DEBT) {
      if (plan.pricePerCollective) {
        extraDescription = ' (Platform Fees)';
      } else {
        extraDescription = ' (Platform Share)';
      }
    }

    const transactionIds = transactions.map(t => t.id);
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
      CollectiveId: host.id,
      currency: host.currency,
      description: `Platform settlement${extraDescription} for ${momentDate.utc().format('MMMM')}`,
      incurredAt: today.toDate(),
      // isPlatformTipSettlement is deprecated but we keep it for now, we should rely on type=SETTLEMENT
      data: { isPlatformTipSettlement: true, transactionIds },
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

      // Attach CSV
      const csvUrl = getTransactionsCsvUrl('transactions', host, {
        startDate,
        endDate,
        kind: transactionsKinds,
        add: ['orderLegacyId'],
      });
      if (csvUrl) {
        await models.ExpenseAttachedFile.create({
          url: csvUrl,
          ExpenseId: expense.id,
          CreatedByUserId: PlatformConstants.PlatformUserId,
        });
      }

      // Mark transactions as invoiced
      await models.TransactionSettlement.markTransactionsAsInvoiced(transactions, expense.id);

      const platformUser = await models.User.findByPk(PlatformConstants.PlatformUserId);
      await expense.createActivity(activityType.COLLECTIVE_EXPENSE_CREATED, platformUser);

      // If running for the month of `PLATFORM_MIGRATION_DATE`, add a comment to explain why we're using a different profile
      if (momentDate.isSame(PLATFORM_MIGRATION_DATE, 'month') && momentDate.isSame(PLATFORM_MIGRATION_DATE, 'year')) {
        await models.Comment.create({
          CreatedByUserId: platformUser.id,
          FromCollectiveId: platformUser.CollectiveId,
          CollectiveId: host.id,
          ExpenseId: expense.id,
          type: CommentType.COMMENT,
          html: `<div>Dear ${host.name},<br /><br /></div><div>You may notice that this expense comes from the "<a href="https://opencollective.com/ofitech">Ofitech</a>" profile instead of "<a href="https://opencollective.com/opencollective">Open Collective</a>". This change is part of a recent transition of the Open Collective platform to a community-governed non-profit. For more information, you can read the full announcement <a href="https://blog.opencollective.com/the-open-collective-platform-is-moving-to-a-community-governed-non-profit/">here</a>.<br /><br />As always, if you have any questions or need assistance, please reach out via <a href="https://opencollective.com/contact">our contact page</a>.<br /><br />Thank you for your understanding and continued support!</div>`,
        });
      }
    }
  }
}

if (require.main === module) {
  runCronJob('host-settlement', () => run(defaultDate), 23 * 60 * 60);
}
