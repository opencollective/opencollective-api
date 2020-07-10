import debugLib from 'debug';
import moment from 'moment';

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
    -- In the case this is a fees on top transaction, the currency will already be USD
    currency,
    SUM(
      CASE
        WHEN (t."data"->>'isFeesOnTop' = 'true' AND t."type" = 'CREDIT' AND t."CollectiveId" = 1) THEN t."amount"
        ELSE -t."platformFeeInHostCurrency"
      END
    ) as "amount"
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
          max((CASE WHEN pm."service" = 'paypal' AND t."CollectiveId" = 1 THEN t."amount" ELSE 0 END)::float) as "feeOnTopPaypal",
          max((CASE WHEN (pm."service" = 'stripe' OR spm.service = 'stripe') AND t."CollectiveId" = 1 THEN t."amount" ELSE 0 END)::float) as "feeOnTopStripe",
          max((CASE WHEN pm."service" != 'stripe' AND pm."service" != 'paypal' AND (spm.service IS NULL OR spm.service != 'stripe') AND t."CollectiveId" = 1 THEN t."platformFeeInHostCurrency" ELSE 0 END)::float) as "feeOnTopManual",
          max((CASE WHEN (pm."service" != 'stripe' OR pm.service IS NULL) AND (spm.service IS NULL OR spm.service != 'stripe') AND t."CollectiveId" = 1 THEN t."amount" ELSE 0 END)::float) as "feeOnTopDue",
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
          sum("feeOnTopManual") AS "feesOnTopManual",
          sum("feeOnTopStripe") AS "feesOnTopStripe",
          sum("feeOnTopDue") AS "feesOnTopDue"
        FROM "feesOnTopTransactions"
        GROUP BY "HostCollectiveId"
      )

      SELECT
        hc.slug as "host",
        hc.currency,
        d.*,
        stats.*,
        fot.*,
        COALESCE(fot."feesOnTopPaypal", 0) + COALESCE(fot."feesOnTopManual", 0) + COALESCE(fot."feesOnTopStripe", 0) as "feesOnTop" 
      FROM "donationsData" d
      LEFT JOIN "hostedCollectivesStats" stats ON d."HostCollectiveId" = stats."HostCollectiveId"
      LEFT JOIN "feesOnTopByHost" fot ON fot."HostCollectiveId" = d."HostCollectiveId"
      LEFT JOIN "Collectives" hc ON hc.id = d."HostCollectiveId"
      WHERE d."platformFees" > 0
      ORDER BY d."totalRevenue" DESC
    `,
      { startDate, endDate },
    );

    hosts = hosts.map(host => {
      const isUSD = host.currency === 'USD';
      return {
        ...host,
        isUSD,
        totalFeesDue: isUSD ? (host.feesOnTopDue || 0) + host.platformFeesDue : null,
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
    const platformAdmins = await models.Member.findAll({ where: { CollectiveId: 1, role: 'ADMIN' } });
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
