#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import { parse as json2csv } from 'json2csv';
import { groupBy, pick, sumBy } from 'lodash';
import moment from 'moment';
import { v4 as uuid } from 'uuid';

import activityType from '../../server/constants/activities';
import expenseStatus from '../../server/constants/expense_status';
import expenseTypes from '../../server/constants/expense_type';
import { SETTLEMENT_EXPENSE_PROPERTIES } from '../../server/constants/transactions';
import { uploadToS3 } from '../../server/lib/awsS3';
import { getPendingHostFeeShare, getPendingPlatformTips } from '../../server/lib/host-metrics';
import { parseToBoolean } from '../../server/lib/utils';
import models, { sequelize } from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';

const today = moment.utc();

const defaultDate = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();

const DRY = process.env.DRY;
const HOST_ID = process.env.HOST_ID;
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
  console.info('Running dry, changes are not going to be persisted to the DB.');
}

const ATTACHED_CSV_COLUMNS = ['createdAt', 'description', 'amount', 'currency', 'OrderId', 'TransactionGroup'];

export async function run(baseDate: Date | moment.Moment = defaultDate): Promise<void> {
  const momentDate = moment(baseDate).subtract(1, 'month');
  const year = momentDate.year();
  const month = momentDate.month();
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 1);

  console.info(`Invoicing hosts pending fees and tips for ${momentDate.format('MMMM')}.`);

  const payoutMethods = groupBy(
    await models.PayoutMethod.findAll({
      where: { CollectiveId: SETTLEMENT_EXPENSE_PROPERTIES.FromCollectiveId, isSaved: true },
    }),
    'type',
  );

  const hosts = await sequelize.query(
    `
      SELECT c.*
      FROM "Collectives" c
      INNER JOIN "Transactions" t ON t."HostCollectiveId" = c.id AND t."deletedAt" IS NULL
      WHERE c."isHostAccount" IS TRUE
      AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
      AND c.id != 8686 -- Make sure we don't invoice OC Inc as reverse settlements are not supported yet
      GROUP BY c.id
    `,
    {
      mapToModel: true,
      type: sequelize.QueryTypes.SELECT,
      model: models.Collective,
      replacements: { startDate: startDate, endDate: endDate },
    },
  );

  for (const host of hosts) {
    const pendingPlatformTips = await getPendingPlatformTips(host, { startDate, endDate });
    const pendingHostFeeShare = await getPendingHostFeeShare(host, { startDate, endDate });

    if (HOST_ID && host.id !== parseInt(HOST_ID)) {
      continue;
    }

    const plan = await host.getPlan();

    let items = [];

    const transactions = await sequelize.query(
      `SELECT t.*
FROM "Transactions" as t
INNER JOIN "TransactionSettlements" ts ON ts."TransactionGroup" = t."TransactionGroup" AND t.kind = ts.kind
WHERE t."CollectiveId" = :CollectiveId
AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
AND t."kind" IN ('PLATFORM_TIP_DEBT', 'HOST_FEE_SHARE_DEBT')
AND t."isDebt" IS TRUE
AND t."deletedAt" IS NULL
AND ts."status" != 'SETTLED'`,
      {
        replacements: { CollectiveId: host.id, startDate: startDate, endDate: endDate },
        model: models.Transaction,
        mapToModel: true, // pass true here if you have any mapped fields
      },
    );

    items.push({
      incurredAt: new Date(),
      amount: pendingPlatformTips,
      description: 'Platform Tips',
    });

    items.push({
      incurredAt: new Date(),
      amount: pendingHostFeeShare,
      description: 'Shared Revenue',
    });

    if (plan.pricePerCollective) {
      const activeHostedCollectives = await host.getHostedCollectivesCount();
      const amount = (activeHostedCollectives || 0) * plan.pricePerCollective;
      if (amount) {
        items.push({
          incurredAt: new Date(),
          amount,
          description: 'Fixed Fee per Hosted Collective',
        });
      }
    }

    const totalAmountCharged = sumBy(items, 'amount');

    if (totalAmountCharged < 1000) {
      console.warn(
        `${host.name} (#${host.id}) skipped, total amount pending ${totalAmountCharged / 100} < 10.00 ${
          host.currency
        }.\n`,
      );
      continue;
    }
    console.info(
      `${host.name} (#${host.id}) has ${transactions.length} pending transactions and owes ${
        totalAmountCharged / 100
      } (${host.currency})`,
    );

    let csv;
    if (transactions.length) {
      csv = json2csv(transactions.map(t => pick(t, ATTACHED_CSV_COLUMNS)));
    }

    if (DRY) {
      console.debug(`Items:\n${json2csv(items)}\n`);
    } else {
      const connectedAccounts = await host.getConnectedAccounts({
        where: { deletedAt: null },
      });

      let payoutMethod =
        payoutMethods[PayoutMethodTypes.OTHER]?.[0] || payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0];
      if (
        connectedAccounts?.find(c => c.service === 'transferwise') &&
        payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0]
      ) {
        const currencyCompatibleAccount = payoutMethods[PayoutMethodTypes.BANK_ACCOUNT].find(
          pm => pm.data?.['currency'] === host.currency,
        );
        payoutMethod = currencyCompatibleAccount || payoutMethods[PayoutMethodTypes.BANK_ACCOUNT]?.[0];
      } else if (
        connectedAccounts?.find(c => c.service === 'paypal') &&
        !host.settings?.disablePaypalPayouts &&
        payoutMethods[PayoutMethodTypes.PAYPAL]?.[0]
      ) {
        payoutMethod = payoutMethods[PayoutMethodTypes.PAYPAL]?.[0];
      }

      if (!payoutMethod) {
        console.error('No Payout Method found, Open Collective Inc. needs to have at least one payout method.');
        process.exit();
      }

      // Create the Expense
      const transactionIds = transactions.map(t => t.TransactionId);
      const expense = await models.Expense.create({
        ...SETTLEMENT_EXPENSE_PROPERTIES,
        PayoutMethodId: payoutMethod.id,
        amount: totalAmountCharged,
        CollectiveId: host.id,
        currency: host.currency,
        description: `Platform settlement for ${momentDate.utc().format('MMMM')}`,
        incurredAt: today,
        data: { isPlatformTipSettlement: true, transactionIds },
        type: expenseTypes.INVOICE,
        status: expenseStatus.PENDING,
      });

      // Create Expense Items
      items = items.map(i => ({
        ...i,
        ExpenseId: expense.id,
        CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
      }));

      await models.ExpenseItem.bulkCreate(items);

      // Attach CSV
      if (csv) {
        const Body = csv;
        const filenameBase = `${host.name}-${momentDate.format('MMMM-YYYY')}`;
        const Key = `${filenameBase}.${uuid().split('-')[0]}.csv`;
        const { Location: url } = await uploadToS3({
          Bucket: config.aws.s3.bucket,
          Key,
          Body,
          ACL: 'public-read',
          ContentType: 'text/csv',
        });
        await models.ExpenseAttachedFile.create({
          url,
          ExpenseId: expense.id,
          CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
        });
      }

      // Mark transactions as invoiced
      await models.TransactionSettlement.markTransactionsAsInvoiced(transactions, expense.id);
      await expense.createActivity(activityType.COLLECTIVE_EXPENSE_CREATED);
    }
  }
}

if (require.main === module) {
  run(defaultDate)
    .catch(e => {
      console.error(e);
      process.exit(1);
    })
    .then(() => {
      process.exit();
    });
}
