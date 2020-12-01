#!/usr/bin/env node
import '../../server/env';

import config from 'config';
import { parse as json2csv } from 'json2csv';
import { compact, entries, groupBy, mapValues, pick, round, sumBy, values } from 'lodash';
import moment from 'moment';

import expenseStatus from '../../server/constants/expense_status';
import expenseTypes from '../../server/constants/expense_type';
import plans from '../../server/constants/plans';
import { SETTLEMENT_EXPENSE_PROPERTIES, TransactionTypes } from '../../server/constants/transactions';
import { uploadToS3 } from '../../server/lib/awsS3';
import { generateKey } from '../../server/lib/encryption';
import models, { sequelize } from '../../server/models';
import { PayoutMethodTypes } from '../../server/models/PayoutMethod';

// Only run on the 5th of the month
const date = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();
const isDry = process.env.DRY;
const isProduction = config.env === 'production';
if (isProduction && date.getDate() !== 5) {
  console.log('OC_ENV is production and today is not the 5th of month, script aborted!');
  process.exit();
}
if (isProduction && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and this script is currently only running manually. Use OFFCYCLE=1.');
  process.exit();
}
if (isDry) {
  console.info('Running dry, changes are not going to be persisted to the DB.');
}

const ATTACHED_CSV_COLUMNS = [
  'createdAt',
  'description',
  'CollectiveSlug',
  'amount',
  'currency',
  'OrderId',
  'TransactionId',
  'PaymentService',
  'source',
];

const sharedRevenuePlans = compact(values(mapValues(plans, (v, k) => (v.hostFeeSharePercent > 0 ? k : undefined))));

export async function run() {
  console.info(`Invoicing hosts pending fees and tips for ${moment(date).subtract(1, 'month').format('MMMM')}.`);
  const [pastMonthTransactions] = await sequelize.query(
    `
    WITH "platformTips" AS (
      SELECT
        t."createdAt",
        t.description,
        round(t."netAmountInCollectiveCurrency"::float / COALESCE((t."data"->>'hostToPlatformFxRate')::float, 1)) AS "amount",
        ot."hostCurrency" AS "currency",
        ot."CollectiveId",
        c."slug" AS "CollectiveSlug",
        ot."HostCollectiveId",
        h."name" AS "HostName",
        ot."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Platform Tips'::TEXT AS "source",
        h.plan,
        CASE
          WHEN h."isActive" THEN h.id
          ELSE (h."settings"->'hostCollective'->>'id')::INT
        END as "chargedHostId"
      FROM
        "Transactions" t
      LEFT JOIN "Transactions" ot ON
        t."PlatformTipForTransactionGroup"::uuid = ot."TransactionGroup"
        AND ot.type = 'CREDIT'
        AND ot."PlatformTipForTransactionGroup" IS NULL
      LEFT JOIN "Collectives" h ON
        ot."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        ot."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month', date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month', date :date)
        AND t."deletedAt" IS NULL
        AND t."CollectiveId" = 1
        AND t."PlatformTipForTransactionGroup" IS NOT NULL
        AND t."type" = 'CREDIT'
        AND (
          pm."service" != 'stripe'
          OR pm.service IS NULL
        )
        AND (
          spm.service IS NULL
          OR spm.service != 'stripe'
        )
        AND (
          h."type" = 'ORGANIZATION'
          AND h."isHostAccount" = TRUE
        )
      ORDER BY
        t."createdAt"
    ),
    "platformFees" AS (
      SELECT
        t."createdAt",
        t.description,
        -t."platformFeeInHostCurrency" AS "amount",
        t."hostCurrency" AS "currency",
        t."CollectiveId",
        c."slug" AS "CollectiveSlug",
        t."HostCollectiveId",
        h."name" AS "HostName",
        t."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Platform Fees'::TEXT AS "source",
        h.plan,
        CASE
          WHEN h."isActive" THEN h.id
          ELSE (h."settings"->'hostCollective'->>'id')::INT
        END as "chargedHostId"
      FROM
        "Transactions" t
      LEFT JOIN "Collectives" h ON
        t."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        t."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month', date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month', date :date)
        AND t."deletedAt" IS NULL
        AND t."type" = 'CREDIT'
        AND t."platformFeeInHostCurrency" != 0
        AND (
          pm."service" != 'stripe'
          OR pm.service IS NULL
        )
        AND (
          spm.service IS NULL
          OR spm.service != 'stripe'
        )
        AND (
          h."type" = 'ORGANIZATION'
          AND h."isHostAccount" = TRUE
        )
      ORDER BY
        t."createdAt"
    ),
    "sharedRevenue" as (
      SELECT
        t."createdAt",
        t.description,
        -t."hostFeeInHostCurrency" AS "amount",
        t."hostCurrency" AS "currency",
        t."CollectiveId",
        c."slug" AS "CollectiveSlug",
        t."HostCollectiveId",
        h."name" AS "HostName",
        t."OrderId",
        t.id AS "TransactionId",
        t.data,
        pm."service" AS "PaymentService",
        spm."service" AS "SourcePaymentService",
        'Shared Revenue'::TEXT AS "source",
        h.plan, 
        CASE
          WHEN h."isActive" THEN h.id
          ELSE (h."settings"->'hostCollective'->>'id')::INT
        END as "chargedHostId"
      FROM
        "Transactions" t
      LEFT JOIN "Collectives" h ON
        t."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        t."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month', date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month', date :date)
        AND t."deletedAt" IS NULL
        AND t."type" = 'CREDIT'
        AND t."hostFeeInHostCurrency" != 0
        -- Ignore transactions that incurred in platformFee
        AND t."platformFeeInHostCurrency" = 0
        AND t."data"->>'settled' IS NULL
        -- Ignore opensource and foundation:
        AND t."HostCollectiveId" NOT IN (11004, 11049)
      AND (
        h."type" = 'ORGANIZATION'
        AND h."isHostAccount" = TRUE
        AND h."plan" in ('${sharedRevenuePlans.join("', '")}')
      )
    ORDER BY
      t."createdAt"
    )

    SELECT
      *
    FROM
      "platformFees"
    UNION
    SELECT
      *
    FROM
      "platformTips"
    UNION
    SELECT
      *
    FROM
      "sharedRevenue";
  `,
    { replacements: { date: date.format('L') } },
  );
  const byHost = groupBy(pastMonthTransactions, 'HostCollectiveId');
  const today = moment.utc();
  const payoutMethods = await models.PayoutMethod.findAll({
    where: { CollectiveId: SETTLEMENT_EXPENSE_PROPERTIES.FromCollectiveId },
  });

  for (const [hostId, hostTransactions] of entries(byHost)) {
    const { HostName, currency, plan, chargedHostId } = hostTransactions[0];

    let items = entries(groupBy(hostTransactions, 'source')).map(([source, transactions]) => {
      const incurredAt = date;
      const description = source;
      let amount = round(sumBy(transactions, 'amount'));
      if (source === 'Shared Revenue') {
        const { hostFeeSharePercent } = plans[plan];
        amount = round(amount * (hostFeeSharePercent / 100));
      }
      return { incurredAt, amount, description };
    });

    const transactionIds = hostTransactions.map(t => t.id);
    const totalAmountCredited = sumBy(items, i => (i.description === 'Shared Revenue' ? 0 : i.amount));
    const totalAmountCharged = sumBy(items, i => i.amount);
    console.info(
      `${HostName} (#${hostId}) has ${hostTransactions.length} pending transactions and owes ${
        totalAmountCharged / 100
      } (${currency})`,
    );
    if (isDry) {
      console.debug(`Items:\n${json2csv(items)}\n`);
    }

    if (!isDry) {
      if (!chargedHostId) {
        console.error(`Warning: We don't have a way to submit the expense to ${HostName}, ignoring.\n`);
        continue;
      }
      // Credit the Host with platform tips collected during the month
      await models.Transaction.create({
        amount: totalAmountCredited,
        amountInHostCurrency: totalAmountCredited,
        CollectiveId: chargedHostId,
        CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
        currency: currency,
        description: `Platform Fees and Tips collected in ${moment.utc().subtract(1, 'month').format('MMMM')}`,
        FromCollectiveId: SETTLEMENT_EXPENSE_PROPERTIES.FromCollectiveId,
        HostCollectiveId: hostId,
        hostCurrency: currency,
        netAmountInCollectiveCurrency: totalAmountCredited,
        type: TransactionTypes.CREDIT,
      });

      const host = await models.Collective.findByPk(hostId);
      const connectedAccounts = await host.getConnectedAccounts({
        where: { deletedAt: null },
      });

      let PayoutMethod = payoutMethods.find(pm => pm.type === PayoutMethodTypes.BANK_ACCOUNT);
      if (
        connectedAccounts?.find?.(c => c.service === 'paypal') &&
        !host.settings?.disablePaypalPayouts &&
        payoutMethods.find(pm => pm.type === PayoutMethodTypes.PAYPAL)
      ) {
        PayoutMethod = payoutMethods.find(pm => pm.type === PayoutMethodTypes.PAYPAL);
      }

      // Create the Expense
      const expense = await models.Expense.create({
        ...SETTLEMENT_EXPENSE_PROPERTIES,
        PayoutMethodId: PayoutMethod.id,
        amount: totalAmountCharged,
        CollectiveId: chargedHostId,
        currency: currency,
        description: `Platform settlement for ${moment.utc().subtract(1, 'month').format('MMMM')}`,
        incurredAt: today,
        data: { isPlatformTipSettlement: true, transactionIds },
        type: expenseTypes.INVOICE,
        status: expenseStatus.APPROVED,
      });

      // Create Expense Items
      items = items.map(i => ({
        ...i,
        ExpenseId: expense.id,
        CreatedByUserId: SETTLEMENT_EXPENSE_PROPERTIES.UserId,
      }));
      await models.ExpenseItem.bulkCreate(items);

      // Attach CSV
      const Body = json2csv(hostTransactions.map(t => pick(t, ATTACHED_CSV_COLUMNS)));
      const filenameBase = `${HostName}-${moment(date).subtract(1, 'month').format('MMMM-YYYY')}`;
      const Key = `${filenameBase}.${generateKey().slice(0, 6)}.csv`;
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
  }
}

if (require.main === module) {
  run()
    .catch(e => {
      console.error(e);
      process.exit(1);
    })
    .then(() => {
      process.exit();
    });
}
