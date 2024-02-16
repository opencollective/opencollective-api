#!/usr/bin/env node
import '../server/env';

import config from 'config';
import { Parser as json2csv } from '@json2csv/plainjs';
import { entries, groupBy, pick, round, sumBy } from 'lodash';
import moment from 'moment';

import { SHARED_REVENUE_PLANS } from '../server/constants/plans';
import models, { sequelize } from '../server/models';

const date = process.env.START_DATE ? moment.utc(process.env.START_DATE) : moment.utc();
const DRY = process.env.DRY;
const HOST_ID = process.env.HOST_ID;
const isProduction = config.env === 'production';

// Only run on the 1th of the month
if (isProduction && date.date() !== 1 && !process.env.OFFCYCLE) {
  console.log('OC_ENV is production and today is not the 1st of month, script aborted!');
  process.exit();
}

if (DRY) {
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

async function run() {
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
        t."TransactionGroup" = ot."TransactionGroup"
        AND ot.type = 'CREDIT'
        AND ot.kind IN ('CONTRIBUTION', 'ADDED_FUNDS') -- we only support adding tips on contributions and addedd funds for now
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
        AND t."CollectiveId" = 8686
        AND t."isDebt" IS NOT TRUE
        AND t."kind" = 'PLATFORM_TIP'
        AND t."type" = 'CREDIT'
        AND ot."HostCollectiveId" NOT IN (8686)
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
        AND t."HostCollectiveId" NOT IN (8686)
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
        -- Ignore Open Collective:
        AND t."HostCollectiveId" != 8686
      AND (
        h."type" = 'ORGANIZATION'
        AND h."isHostAccount" = TRUE
        AND (h."plan" in ('${SHARED_REVENUE_PLANS.join(
          "', '",
        )}') OR h."data"#>>'{plan, hostFeeSharePercent}' IS NOT NULL)
      )
    ORDER BY
      t."createdAt"
    ),
    "tipPaymentProcessorFee" AS (
      SELECT
        t."createdAt",
        t.description,
        round(t."paymentProcessorFeeInHostCurrency"::float / COALESCE((t."data"->>'hostToPlatformFxRate')::float, 1)) AS "amount",
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
        'Reimburse: Payment Processor Fee for collected Platform Tips'::TEXT AS "source",
        h.plan,
        CASE
          WHEN h."isActive" THEN h.id
          ELSE (
            h."settings"->'hostCollective'->>'id'
          )::INT
        END AS "chargedHostId"
      FROM
        "Transactions" t
      LEFT JOIN "Transactions" ot ON
        t."TransactionGroup" = ot."TransactionGroup"
        AND ot.type = 'CREDIT'
        AND ot.kind IN ('CONTRIBUTION', 'ADDED_FUNDS') -- we only support adding tips on contributions and addedd funds for now
      LEFT JOIN "Collectives" h ON
        ot."HostCollectiveId" = h.id
      LEFT JOIN "Collectives" c ON
        ot."CollectiveId" = c.id
      LEFT JOIN "PaymentMethods" pm ON
        t."PaymentMethodId" = pm.id
      LEFT JOIN "PaymentMethods" spm ON
        spm.id = pm."SourcePaymentMethodId"
      WHERE
        t."createdAt" >= date_trunc('month',  date :date - INTERVAL '1 month')
        AND t."createdAt" < date_trunc('month',  date :date)
        AND t."deletedAt" IS NULL
        AND t."CollectiveId" = 8686
        AND t."kind" = 'PLATFORM_TIP'
        AND t."type" = 'CREDIT'
        AND t."paymentProcessorFeeInHostCurrency" != 0
        AND ot."HostCollectiveId" NOT IN (8686)
        AND (
          pm."service" = 'stripe'
          OR spm.service = 'stripe'
        )
        AND (
          h."type" = 'ORGANIZATION'
          AND h."isHostAccount" = TRUE
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
      "sharedRevenue"
    UNION
    SELECT
      *
    FROM
      "tipPaymentProcessorFee";
  `,
    { replacements: { date: date.format('L') } },
  );
  const byHost = groupBy(pastMonthTransactions, 'HostCollectiveId');

  for (const [hostId, hostTransactions] of entries(byHost)) {
    if (HOST_ID && hostId !== parseInt(HOST_ID)) {
      continue;
    }

    const host = await models.Collective.findByPk(hostId);
    const plan = await host.getPlan();

    const { HostName, currency } = hostTransactions[0];

    const hostFeeSharePercent = plan.hostFeeSharePercent;
    const transactions = hostTransactions.map(t => {
      if (t.source === 'Shared Revenue') {
        // In this context, the original t.amount is actually -t.hostFeeInHostCurrency
        t.amount = round(t.amount * ((t.data?.hostFeeSharePercent || hostFeeSharePercent) / 100));
      }
      return t;
    });

    const items = entries(groupBy(transactions, 'source')).map(([source, ts]) => {
      const incurredAt = date;
      const description = source;
      const amount = round(sumBy(ts, 'amount'));
      return { incurredAt, amount, description };
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
        `${HostName} (#${hostId}) skipped, total amound pending ${totalAmountCharged / 100} < 10.00 ${currency}.\n`,
      );
      continue;
    }
    console.info(
      `${HostName} (#${hostId}) has ${transactions.length} pending transactions and owes ${
        totalAmountCharged / 100
      } (${currency})`,
    );
    const csv = new json2csv().parse(transactions.map(t => pick(t, ATTACHED_CSV_COLUMNS)));

    if (DRY) {
      console.debug(`Items:\n${new json2csv().parse(items)}\n`);
      console.debug(csv);
    } else {
      console.log('This script is not active anymore and can only be used in DRY mode!');
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
