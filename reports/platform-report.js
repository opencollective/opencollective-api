import debugLib from 'debug';
import moment from 'moment';

import plans, { SHARED_REVENUE_PLANS } from '../server/constants/plans';
import MemberRoles from '../server/constants/roles.ts';
import { reduceArrayToCurrency } from '../server/lib/currency';
import emailLib from '../server/lib/email';
import { getBackersStats } from '../server/lib/hostlib';
import models, { Op, sequelize } from '../server/models';

const debug = debugLib('hostreport');

const query = (query, values) => {
  return sequelize.query(query, {
    type: sequelize.QueryTypes.SELECT,
    replacements: values,
  });
};

const getPlatformRevenue = async (startDate, endDate) => {
  const res = await query(
    `
  SELECT
    currency,
    SUM(
      CASE
        WHEN (t."CollectiveId" = 1) and t."data"->>'isFeesOnTop' = 'true' THEN t."amount" -- Fees on Top
        ELSE -t."platformFeeInHostCurrency" -- Platform Fee
      END
    ) AS "amount"
  FROM "Transactions" t
  WHERE t."deletedAt" IS NULL
    AND t."OrderId" IS NOT NULL
    AND t.type = 'CREDIT'
    AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
  GROUP BY t."currency"
  ORDER BY "amount" DESC
  `,
    { startDate, endDate },
  );
  return res;
};

const getNumberOfActiveHosts = async (startDate, endDate) => {
  const activeHosts = await query(
    `SELECT COUNT(DISTINCT "HostCollectiveId")
  FROM "Transactions"
  WHERE "HostCollectiveId" IS NOT NULL
    AND "createdAt" >= :startDate AND "createdAt" < :endDate`,
    { startDate, endDate },
  );
  const newHosts = await query(
    `SELECT COUNT(DISTINCT "CollectiveId")
    FROM "ConnectedAccounts"
    WHERE service='stripe'
      AND "createdAt" >= :startDate AND "createdAt" < :endDate`,
    { startDate, endDate },
  );
  const totalHosts = await query(
    `SELECT COUNT(DISTINCT "CollectiveId")
    FROM "ConnectedAccounts"
    WHERE service='stripe'
    AND "createdAt" < :endDate`,
    { startDate, endDate },
  );
  return {
    active: activeHosts[0].count,
    new: newHosts[0].count,
    total: totalHosts[0].count,
  };
};

async function PlatformReport(year, month) {
  const startTime = new Date();
  let previousStartDate, startDate, endDate;

  const d = new Date();
  d.setFullYear(year);
  let yearlyReport = false;
  if (typeof month === 'number') {
    d.setMonth(month);
    previousStartDate = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    startDate = new Date(d.getFullYear(), d.getMonth(), 1);
    endDate = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  } else {
    // yearly report
    yearlyReport = true;
    previousStartDate = new Date(d.getFullYear() - 1, 0, 1);
    startDate = new Date(d.getFullYear(), 0, 1);
    endDate = new Date(d.getFullYear() + 1, 0, 1);
  }

  const reportName = yearlyReport ? `${year} Yearly Platform Report` : `${year}/${month + 1} Monthly Platform Report`;
  console.log('startDate', startDate, 'endDate', endDate);

  year = year || startDate.getFullYear();
  const computeDelta = (obj1, obj2) => {
    if (!obj2) {
      return obj1;
    }
    const row = {};
    Object.keys(obj1).map(attr => {
      if (!obj2[attr]) {
        row[attr] = obj1[attr];
      } else if (isNaN(obj1[attr])) {
        row[attr] = obj2[attr];
      } else {
        row[attr] = obj2[attr] - obj1[attr];
      }
    });
    return row;
  };

  const getPlatformStats = async () => {
    console.log('>>> Computing platform stats');

    let hosts = await query(
      `
      with "donationsData" as (
        SELECT t."HostCollectiveId",
        count(DISTINCT t."FromCollectiveId") as "backers",
        count(DISTINCT t."CollectiveId") as "activeCollectives",
        SUM("amount")::float as "totalRevenue",
        -SUM("hostFeeInHostCurrency")::float as "hostFees",
        -SUM(CASE WHEN pm."service" = 'paypal' THEN t."platformFeeInHostCurrency" ELSE 0 END)::float as "platformFeesPaypal",
        -SUM(CASE WHEN pm."service" = 'stripe' OR spm.service = 'stripe' THEN t."platformFeeInHostCurrency" ELSE 0 END)::float as "platformFeesStripe",
        -SUM(CASE WHEN t."PaymentMethodId" is NULL THEN t."platformFeeInHostCurrency" ELSE 0 END)::float as "platformFeesBankTransfers",
        -SUM(CASE WHEN pm."service" != 'stripe' AND pm."service" != 'paypal' AND (spm.service IS NULL OR spm.service != 'stripe') THEN t."platformFeeInHostCurrency" ELSE 0 END)::float as "platformFeesManual",
        -SUM(CASE WHEN (pm."service" != 'stripe' OR pm.service IS NULL) AND (spm.service IS NULL OR spm.service != 'stripe') THEN t."platformFeeInHostCurrency" ELSE 0 END)::float as "platformFeesDue",
        -sum("platformFeeInHostCurrency")::float as "platformFees",
        "hostCurrency"
        FROM "Transactions" t
        LEFT JOIN "PaymentMethods" pm ON pm.id = t."PaymentMethodId"
        LEFT JOIN "PaymentMethods" spm ON spm.id = pm."SourcePaymentMethodId"
        WHERE t.type='CREDIT'
          AND t."OrderId" IS NOT NULL
          AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
          AND t."deletedAt" IS NULL
        GROUP BY t."hostCurrency", t."HostCollectiveId"
      ),
      "hostedCollectivesStats" as (
        SELECT "HostCollectiveId", COUNT(DISTINCT m."CollectiveId") as "collectives", COUNT(DISTINCT t."CollectiveId") as "activeCollectives"
        FROM "Transactions" t
        LEFT JOIN "Members" m ON m."MemberCollectiveId" = t."HostCollectiveId" AND m.role='HOST'
        WHERE t."HostCollectiveId" IS NOT NULL
          AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
          AND t."deletedAt" IS NULL
          AND m."deletedAt" IS NULL
        GROUP BY t."HostCollectiveId"
      ),
      "feesOnTopTransactions" AS (
        SELECT
          max((CASE WHEN pm."service" = 'paypal' AND t."CollectiveId" = 8686 THEN t."netAmountInCollectiveCurrency" ELSE 0 END)::float) as "feeOnTopPaypal",
          max((CASE WHEN (pm."service" = 'stripe' OR spm.service = 'stripe') AND t."CollectiveId" = 8686 THEN t."netAmountInCollectiveCurrency" ELSE 0 END)::float) as "feeOnTopStripe",
          max((CASE WHEN t."PaymentMethodId" is NULL AND t."CollectiveId" = 8686 THEN t."netAmountInCollectiveCurrency" ELSE 0 END)::float) as "feeOnTopBankTransfers",
          max(CASE WHEN t."CollectiveId" = 8686 and pm."service" != 'stripe' AND pm."service" != 'paypal' AND (spm.service IS NULL OR spm.service != 'stripe') THEN t."netAmountInCollectiveCurrency" ELSE 0 END)::float as "feeOnTopManual",
          max((CASE WHEN (t."PaymentMethodId" is NULL OR ((pm."service" != 'stripe' OR pm.service IS NULL) AND (spm.service IS NULL OR spm.service != 'stripe'))) AND t."CollectiveId" = 8686 THEN t."netAmountInCollectiveCurrency" ELSE 0 END)::float) as "feeOnTopDue",
          max((CASE WHEN t."CollectiveId" != 1 THEN t."HostCollectiveId" ELSE 0 END)) AS "HostCollectiveId",
          t."OrderId"
          FROM "Transactions" t
          LEFT JOIN "PaymentMethods" pm ON pm.id = t."PaymentMethodId"
          LEFT JOIN "PaymentMethods" spm ON spm.id = pm."SourcePaymentMethodId"
          WHERE
            t."type" = 'CREDIT'
            AND t."data"->>'isFeesOnTop' = 'true'
            AND t."createdAt" >= :startDate AND t."createdAt" < :endDate
          GROUP BY t."OrderId"
      ),
      "feesOnTopByHost" AS (
        SELECT
          "HostCollectiveId",
          sum("feeOnTopPaypal") AS "feesOnTopPaypal",
          sum("feeOnTopBankTransfers") AS "feesOnTopBankTransfers",
          sum("feeOnTopManual") AS "feesOnTopManual",
          sum("feeOnTopStripe") AS "feesOnTopStripe",
          sum("feeOnTopDue") AS "feesOnTopDue",
          COALESCE(sum("feeOnTopPaypal"), 0) + COALESCE(sum("feeOnTopBankTransfers"), 0) + COALESCE(sum("feeOnTopStripe"), 0) + COALESCE(sum("feeOnTopManual"), 0) as "feesOnTop"
        FROM "feesOnTopTransactions"
        GROUP BY "HostCollectiveId"
      ),
      "sharedRevenue" AS (
        SELECT
          t."HostCollectiveId",
          SUM(-t."hostFeeInHostCurrency") AS "sharedRevenueTotal",
          SUM(CASE WHEN t."data"->>'settled' = 'true' THEN -t."hostFeeInHostCurrency" ELSE 0 END) AS "sharedRevenueSettled",
          SUM(CASE WHEN t."data"->>'settled' IS NULL THEN -t."hostFeeInHostCurrency" ELSE 0 END) AS "sharedRevenueDue"
        FROM
          "Transactions" t
        LEFT JOIN "Collectives" h ON h."id" = t."HostCollectiveId" 
        WHERE
          t."createdAt" >= date_trunc('month', NOW() - INTERVAL '1 month')
          AND t."createdAt" < date_trunc('month', NOW())
          AND t."deletedAt" IS NULL
          AND t."type" = 'CREDIT'
          AND t."hostFeeInHostCurrency" != 0
          -- Ignore transactions that incurred in platformFee
          AND t."platformFeeInHostCurrency" = 0
          -- Ignore opensource and foundation:
          AND t."HostCollectiveId" != 8686
          AND (
            h."type" = 'ORGANIZATION'
            AND h."isHostAccount" = TRUE
            AND h."plan" IN ('${SHARED_REVENUE_PLANS.join("', '")}')
          )
          GROUP BY t."HostCollectiveId", t."hostCurrency" 
      )

      SELECT
        hc.slug as "host",
        hc.currency,
        hc.plan,
        d.*,
        stats.*,
        fot.*,
        sr.*
      FROM "donationsData" d
      LEFT JOIN "hostedCollectivesStats" stats ON d."HostCollectiveId" = stats."HostCollectiveId"
      LEFT JOIN "feesOnTopByHost" fot ON fot."HostCollectiveId" = d."HostCollectiveId"
      LEFT JOIN "sharedRevenue" sr ON sr."HostCollectiveId" = d."HostCollectiveId"
      LEFT JOIN "Collectives" hc ON hc.id = d."HostCollectiveId"
      WHERE (d."platformFees" > 0 OR fot."feesOnTop" > 0)
      ORDER BY d."totalRevenue" DESC
    `,
      { startDate, endDate },
    );

    hosts = hosts.map(host => {
      const hostFeeSharePercent = plans[host.plan]?.hostFeeSharePercent || 0;
      const isUSD = host.currency === 'USD';
      const totalSharedRevenueSettled = hostFeeSharePercent && (host.sharedRevenueSettled * hostFeeSharePercent) / 100;
      const totalSharedRevenueDue = hostFeeSharePercent && (host.sharedRevenueDue * hostFeeSharePercent) / 100;
      const totalSharedRevenue = hostFeeSharePercent && (host.sharedRevenueTotal * hostFeeSharePercent) / 100;
      const platformFeesDue = host.platformFeesDue + totalSharedRevenueDue;
      return {
        ...host,
        isUSD,
        totalFeesDue: isUSD ? (host.feesOnTopDue || 0) + host.platformFeesDue : null,
        hasFeesDue: host.feesOnTopDue > 0 || platformFeesDue > 0,
        platformFeesDue,
        totalSharedRevenueSettled,
        totalSharedRevenueDue,
        totalSharedRevenue: totalSharedRevenue,
      };
    });

    const activeHosts = await getNumberOfActiveHosts(startDate, endDate);
    const previousActiveHosts = await getNumberOfActiveHosts(previousStartDate, startDate);

    const backers = await getBackersStats(startDate, endDate);
    const previousPeriodBackers = await getBackersStats(previousStartDate, startDate);

    const platformFeesByCurrency = await getPlatformRevenue(startDate, endDate);
    const platformFeesUSD = Math.round(await reduceArrayToCurrency(platformFeesByCurrency, 'USD'));
    const previousPeriodPlatformFeesByCurrency = await getPlatformRevenue(previousStartDate, startDate);
    const previousPeriodPlatformFeesUSD = Math.round(
      await reduceArrayToCurrency(previousPeriodPlatformFeesByCurrency, 'USD'),
    );

    const data = {
      year,
      month: moment(startDate).format('MMMM'),
      hosts,
      stats: {
        thisMonth: {
          backers,
          platformFees: { currency: 'USD', amount: platformFeesUSD },
          platformFeesByCurrency,
          hosts: activeHosts,
        },
        previousMonth: {
          backers: previousPeriodBackers,
          platformFees: { currency: 'USD', amount: previousPeriodPlatformFeesUSD },
          platformFeesByCurrency: previousPeriodPlatformFeesByCurrency,
          hosts: previousActiveHosts,
        },
        delta: {
          platformFees: { currency: 'USD', amount: platformFeesUSD - previousPeriodPlatformFeesUSD },
          platformFeesByCurrency: previousPeriodPlatformFeesByCurrency.map((previous, i) =>
            computeDelta(previous, platformFeesByCurrency[i]),
          ),
          backers: computeDelta(previousPeriodBackers, backers),
          hosts: computeDelta(previousActiveHosts, activeHosts),
        },
      },
    };
    console.log('>>> stats', JSON.stringify(data.stats, null, '  '));
    const platformAdmins = await models.Member.findAll({
      logging: console.log,
      where: { CollectiveId: 8686, role: { [Op.or]: [MemberRoles.ADMIN, MemberRoles.ACCOUNTANT] } },
    });
    const adminUsers = await models.User.findAll({
      attributes: ['email'],
      where: { CollectiveId: { [Op.in]: platformAdmins.map(m => m.MemberCollectiveId) } },
    });
    await sendEmail(
      adminUsers.map(u => u.email),
      data,
    );
    return data;
  };

  const sendEmail = (recipients, data, attachments) => {
    debug('Sending email to ', recipients);
    if (!recipients || recipients.length === 0) {
      console.error('Unable to send platform report: No recipient to send to');
      return;
    }
    const options = { attachments };
    return emailLib.send('report.platform', recipients, data, options);
  };

  console.log(`Preparing the ${reportName}`);

  await getPlatformStats();

  const timeLapsed = Math.round((new Date() - startTime) / 1000); // in seconds
  console.log(`Total run time: ${timeLapsed}s`);

  console.log('>>> All done. Exiting.');
  process.exit(0);
}

export default PlatformReport;
