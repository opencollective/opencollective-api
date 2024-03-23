import config from 'config';
import { orderBy } from 'lodash';

import { sequelize } from '../models';

import { getTotalMoneyManagedAmount } from './budget';
import { getFxRate } from './currency';
import { computeDatesAsISOStrings } from './utils';

function oppositeTotal(total) {
  return total !== 0 ? -total : total;
}

/**
 * Compute the sum of the given transactions in `currency`
 * @returns number
 */
async function computeTotal(results, currency) {
  let total = 0;

  // For sanity reasons, we handle conversion in case there is any currency mismatch
  for (const result of results) {
    const value = result['_amount'];
    if (value) {
      const fxRate = await getFxRate(result['_currency'], currency);
      total += Math.round(value * fxRate);
    }
  }

  return total;
}

async function convertCurrencyForTimeSeries(results, currency) {
  const fxRates = {}; // FX rates are likely to be the same for all results, better cache them
  for (const result of results) {
    const value = result['_amount'];
    result['currency'] = currency;

    if (value) {
      const resultCurrency = result['_currency'];
      fxRates[resultCurrency] = fxRates[resultCurrency] || {};
      if (!fxRates[resultCurrency][currency]) {
        fxRates[resultCurrency][currency] = await getFxRate(resultCurrency, currency);
      }

      result['amount'] = Math.round(value * fxRates[resultCurrency][currency]);
      result['currency'] = currency;
    } else {
      result['amount'] = 0;
    }
  }

  return results;
}

export async function getPlatformTips(
  host,
  { startDate = null, endDate = null, groupTimeUnit = null, collectiveIds = null } = {},
) {
  const timeUnitFragments = { select: '', groupBy: '', orderBy: '' };
  if (groupTimeUnit) {
    timeUnitFragments.select = ', DATE_TRUNC(:groupTimeUnit, t1."createdAt") AS "date"';
    timeUnitFragments.groupBy = ', DATE_TRUNC(:groupTimeUnit, t1."createdAt")';
    timeUnitFragments.orderBy = ' ORDER BY DATE_TRUNC(:groupTimeUnit, t1."createdAt") ASC';
  }

  const results = await sequelize.query(
    `SELECT
  SUM(
    CASE
      WHEN t2."data"->>'hostToPlatformFxRate' IS NOT NULL THEN
        t2."amountInHostCurrency"::numeric / (t2."data"->>'hostToPlatformFxRate')::numeric
      ELSE
        t2."amountInHostCurrency"
    END
  ) as "_amount",
  (
    CASE
      WHEN t2."data"->>'hostToPlatformFxRate' IS NOT NULL THEN
        h."currency"
      ELSE
        t2."hostCurrency"
    END
   ) as "_currency"${timeUnitFragments.select}
FROM "Transactions" as t1
INNER JOIN "Transactions" as t2
ON t1."TransactionGroup" = t2."TransactionGroup"
INNER JOIN "Collectives" as h
ON t1."HostCollectiveId" = h."id"
WHERE t1."HostCollectiveId" = :HostCollectiveId
${collectiveIds ? `AND t1."CollectiveId" IN (:CollectiveIds)` : ``}
${startDate ? `AND t1."createdAt" >= :startDate` : ``}
${endDate ? `AND t1."createdAt" <= :endDate` : ``}
AND (t1."kind" IS NULL OR t1."kind" IN ('CONTRIBUTION', 'ADDED_FUNDS'))
AND t2."kind" = 'PLATFORM_TIP'
AND t2."type" = 'CREDIT'
AND t1."deletedAt" IS NULL
AND t2."deletedAt" IS NULL
AND t2."RefundTransactionId" IS NULL
GROUP BY "_currency"${timeUnitFragments.groupBy} ${timeUnitFragments.orderBy}`,
    {
      replacements: {
        HostCollectiveId: host.id,
        CollectiveIds: collectiveIds,
        ...computeDatesAsISOStrings(startDate, endDate),
        groupTimeUnit,
      },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  if (groupTimeUnit) {
    return convertCurrencyForTimeSeries(results, host.currency);
  } else {
    return computeTotal(results, host.currency);
  }
}

// NOTE: we're not looking at the settlementStatus and just SUM all debts of the month
export async function getPendingPlatformTips(
  host,
  { startDate = null, endDate = null, collectiveIds = null, status = ['OWED', 'INVOICED'] } = {},
) {
  if (config.env === 'production' && host.slug === 'opencollective') {
    return 0;
  }

  const results = await sequelize.query(
    `SELECT SUM(t."amountInHostCurrency") AS "_amount", t."hostCurrency" as "_currency"
FROM "Transactions" t
INNER JOIN "TransactionSettlements" ts
  ON t."TransactionGroup" = ts."TransactionGroup"
  AND t."kind" = ts."kind"
${collectiveIds ? ` INNER JOIN "Transactions" as t2 ON t."TransactionGroup" = t2."TransactionGroup"` : ``}
WHERE t."HostCollectiveId" = :HostCollectiveId
${collectiveIds ? `AND t2."CollectiveId" IN (:CollectiveIds)` : ``}
AND t."isDebt" IS TRUE
AND t."kind" = 'PLATFORM_TIP_DEBT'
AND t."deletedAt" IS NULL
AND ts."deletedAt" IS NULL
AND ts."status" IN (:status)
${startDate ? `AND t."createdAt" >= :startDate` : ``}
${endDate ? `AND t."createdAt" <= :endDate` : ``}
GROUP BY t."hostCurrency"`,
    {
      replacements: {
        HostCollectiveId: host.id,
        CollectiveIds: collectiveIds,
        status: status,
        ...computeDatesAsISOStrings(startDate, endDate),
      },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  return computeTotal(results, host.currency);
}

export async function getHostFees(host, { startDate = null, endDate = null, fromCollectiveIds = null } = {}) {
  const newResults = await sequelize.query(
    `SELECT SUM(t1."amountInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
WHERE t1."CollectiveId" = :CollectiveId
${fromCollectiveIds ? `AND t1."FromCollectiveId" IN (:FromCollectiveIds)` : ``}
AND t1."kind" = 'HOST_FEE'
${startDate ? `AND t1."createdAt" >= :startDate` : ``}
${endDate ? `AND t1."createdAt" <= :endDate` : ``}
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
    {
      replacements: {
        CollectiveId: host.id,
        FromCollectiveIds: fromCollectiveIds,
        ...computeDatesAsISOStrings(startDate, endDate),
      },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  // TODO(Ledger): We should only run the query below if startDate < newHostFeeDeployDate
  const legacyResults = await sequelize.query(
    `SELECT SUM(t1."hostFeeInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
WHERE t1."HostCollectiveId" = :HostCollectiveId
${fromCollectiveIds ? `AND t1."FromCollectiveId" IN (:FromCollectiveIds)` : ``}
${startDate ? `AND t1."createdAt" >= :startDate` : ``}
${endDate ? `AND t1."createdAt" <= :endDate` : ``}
AND NOT (t1."type" = 'DEBIT' AND t1."kind" = 'ADDED_FUNDS')
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
    {
      replacements: {
        HostCollectiveId: host.id,
        FromCollectiveIds: fromCollectiveIds,
        ...computeDatesAsISOStrings(startDate, endDate),
      },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  let total = await computeTotal(legacyResults, host.currency);

  // amount/hostFeeInHostCurrency is expressed as a negative number
  total = oppositeTotal(total);

  if (newResults?.length) {
    total += await computeTotal(newResults, host.currency);
  }

  return total;
}

export async function getHostFeesTimeSeries(host, { startDate = null, endDate = null, timeUnit } = {}) {
  const newResults = await sequelize.query(
    `SELECT SUM(t1."amountInHostCurrency") as "_amount", t1."hostCurrency" as "_currency", DATE_TRUNC(:timeUnit, t1."createdAt") as "date"
FROM "Transactions" as t1
WHERE t1."CollectiveId" = :CollectiveId
AND t1."kind" = 'HOST_FEE'
${startDate ? `AND t1."createdAt" >= :startDate` : ``}
${endDate ? `AND t1."createdAt" <= :endDate` : ``}
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency", DATE_TRUNC(:timeUnit, t1."createdAt")
ORDER BY DATE_TRUNC(:timeUnit, t1."createdAt")`,
    {
      replacements: { CollectiveId: host.id, ...computeDatesAsISOStrings(startDate, endDate), timeUnit },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  let legacyResults = [];

  const newHostFeeIntroductionDate = new Date('2021-07-01T00:00:00.000Z');
  if (startDate < newHostFeeIntroductionDate) {
    legacyResults = await sequelize.query(
      `SELECT SUM(t1."hostFeeInHostCurrency") as "_amount", t1."hostCurrency" as "_currency", DATE_TRUNC(:timeUnit, t1."createdAt") as "date"
FROM "Transactions" as t1
WHERE t1."HostCollectiveId" = :HostCollectiveId
${startDate ? `AND t1."createdAt" >= :startDate` : ``}
${endDate ? `AND t1."createdAt" <= :endDate` : ``}
AND NOT (t1."type" = 'DEBIT' AND t1."kind" = 'ADDED_FUNDS')
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency", DATE_TRUNC(:timeUnit, t1."createdAt")
ORDER BY DATE_TRUNC(:timeUnit, t1."createdAt")`,
      {
        replacements: { HostCollectiveId: host.id, ...computeDatesAsISOStrings(startDate, endDate), timeUnit },
        type: sequelize.QueryTypes.SELECT,
      },
    );
  }

  const newTimeSeries = await convertCurrencyForTimeSeries(newResults, host.currency);
  const legacyTimeSeries = await convertCurrencyForTimeSeries(legacyResults, host.currency);

  const mergedTimeSeries = [...newTimeSeries.map(point => ({ ...point, amount: Math.abs(point.amount) }))];

  // Merge legacy time series with new time series
  for (const point of legacyTimeSeries) {
    const existingDataPoint = mergedTimeSeries.find(({ date }) => {
      return point.date.getTime() === date.getTime();
    });
    if (existingDataPoint) {
      existingDataPoint.amount += Math.abs(point.amount);
    } else {
      mergedTimeSeries.push({ ...point, amount: Math.abs(point.amount) });
    }
  }

  return orderBy(mergedTimeSeries, 'date');
}

export async function getTotalMoneyManagedTimeSeries(
  host,
  { startDate = null, endDate = null, collectiveIds = null, timeUnit } = {},
) {
  if (!collectiveIds) {
    const hostedCollectiveIds = (await host.getHostedCollectives({ attributes: ['id'], raw: true })).map(c => c.id);
    const hostChildrenIds = (await host.getChildren({ attributes: ['id'], raw: true })).map(c => c.id);
    collectiveIds = [...hostedCollectiveIds, ...hostChildrenIds, host.id];
  }

  const results = await sequelize.query(
    `SELECT
       SUM(COALESCE("amountInHostCurrency", 0)) +
       SUM(COALESCE("platformFeeInHostCurrency", 0)) +
       SUM(COALESCE("hostFeeInHostCurrency", 0)) +
       SUM(COALESCE("paymentProcessorFeeInHostCurrency", 0)) +
       SUM(COALESCE("taxAmount" * "hostCurrencyFxRate", 0)) as "_amount",
       t1."hostCurrency" as "_currency",
       DATE_TRUNC(:timeUnit, t1."createdAt") as "date"
FROM "Transactions" as t1
WHERE t1."HostCollectiveId" = :HostCollectiveId
AND t1."CollectiveId" IN (:CollectiveIds)
${startDate ? `AND t1."createdAt" >= :startDate` : ``}
${endDate ? `AND t1."createdAt" <= :endDate` : ``}
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency", DATE_TRUNC(:timeUnit, t1."createdAt")
ORDER BY DATE_TRUNC(:timeUnit, t1."createdAt")`,
    {
      replacements: {
        ...computeDatesAsISOStrings(startDate, endDate),
        timeUnit,
        HostCollectiveId: host.id,
        CollectiveIds: collectiveIds,
      },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  const balanceAtStartDate = await getTotalMoneyManagedAmount(host, {
    endDate: startDate,
    collectiveIds,
    currency: host.currency,
  });
  const timeSeries = await convertCurrencyForTimeSeries(results, host.currency);
  let sum;
  return timeSeries.map(point => {
    sum = (sum || 0) + point.amount;
    return { ...point, amount: Math.abs(sum + balanceAtStartDate.value) };
  });
}

export async function getHostFeeShare(host, { startDate = null, endDate = null, collectiveIds = null } = {}) {
  if (config.env === 'production' && host.slug === 'opencollective') {
    return 0;
  }

  const results = await sequelize.query(
    `SELECT SUM(t1."amountInHostCurrency") as "_amount", t1."hostCurrency" as "_currency"
FROM "Transactions" as t1
${
  collectiveIds
    ? `INNER JOIN "Transactions" AS t2 ON t1."TransactionGroup" = t2."TransactionGroup"
       WHERE t2.kind IN ('CONTRIBUTION', 'ADDED_FUNDS')
       AND t2."HostCollectiveId" = :CollectiveId
       AND t2."deletedAt" IS NULL
       AND t2."CollectiveId" IN (:CollectiveIds)
       AND t1."CollectiveId" = :CollectiveId`
    : `WHERE t1."CollectiveId" = :CollectiveId`
}
AND t1."kind" = 'HOST_FEE_SHARE'
${startDate ? `AND t1."createdAt" >= :startDate` : ``}
${endDate ? `AND t1."createdAt" <= :endDate` : ``}
AND t1."deletedAt" IS NULL
GROUP BY t1."hostCurrency"`,
    {
      replacements: {
        CollectiveId: host.id,
        CollectiveIds: collectiveIds,
        ...computeDatesAsISOStrings(startDate, endDate),
      },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  let total = await computeTotal(results, host.currency);

  // we're looking at the DEBIT, so it's a negative number
  total = oppositeTotal(total);

  return total;
}

export async function getHostFeeShareTimeSeries(host, { startDate = null, endDate = null, timeUnit } = {}) {
  const results = await sequelize.query(
    `SELECT
      SUM(t1."amountInHostCurrency") as "_amount",
      t1."hostCurrency" as "_currency",
      DATE_TRUNC(:timeUnit, t1."createdAt") as "date",
      COALESCE(ts."status", 'SETTLED') as "settlementStatus"
    FROM "Transactions" as t1
    LEFT JOIN "TransactionSettlements" ts
      ON t1."TransactionGroup" = ts."TransactionGroup"
      AND ts.kind = 'HOST_FEE_SHARE_DEBT'
      AND ts."deletedAt" IS NULL
    WHERE t1."CollectiveId" = :CollectiveId
    AND t1."kind" = 'HOST_FEE_SHARE'
    ${startDate ? `AND t1."createdAt" >= :startDate` : ``}
    ${endDate ? `AND t1."createdAt" <= :endDate` : ``}
    AND t1."deletedAt" IS NULL
    GROUP BY t1."hostCurrency", DATE_TRUNC(:timeUnit, t1."createdAt"), COALESCE(ts."status", 'SETTLED')
    ORDER BY DATE_TRUNC(:timeUnit, t1."createdAt"), COALESCE(ts."status", 'SETTLED')`,
    {
      replacements: { CollectiveId: host.id, ...computeDatesAsISOStrings(startDate, endDate), timeUnit },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  const preparedTimeSeries = await convertCurrencyForTimeSeries(results, host.currency);
  return preparedTimeSeries.map(point => ({ ...point, amount: Math.abs(point.amount) }));
}

export async function getPendingHostFeeShare(
  host,
  { startDate = null, endDate = null, collectiveIds = null, status = ['OWED', 'INVOICED'] } = {},
) {
  const results = await sequelize.query(
    `SELECT SUM(t."amountInHostCurrency") AS "_amount", t."hostCurrency" as "_currency"
        FROM "Transactions" t
        INNER JOIN "TransactionSettlements" ts
          ON t."TransactionGroup" = ts."TransactionGroup"
          AND t."kind" = ts."kind"
        ${
          collectiveIds
            ? `INNER JOIN "Transactions" AS t2 ON t."TransactionGroup" = t2."TransactionGroup"
               WHERE t2.kind IN ('CONTRIBUTION', 'ADDED_FUNDS')
               AND t2."deletedAt" IS NULL
               AND t2."CollectiveId" IN (:FromCollectiveIds)
               AND t."CollectiveId" = :CollectiveId`
            : `WHERE t."CollectiveId" = :CollectiveId`
        }
          AND t."kind" = 'HOST_FEE_SHARE_DEBT'
          AND t."deletedAt" IS NULL
          AND ts."deletedAt" IS NULL
          AND ts."status" IN (:status)
          ${startDate ? `AND t."createdAt" >= :startDate` : ``}
          ${endDate ? `AND t."createdAt" <= :endDate` : ``}
        GROUP BY t."hostCurrency"`,
    {
      replacements: {
        CollectiveId: host.id,
        FromCollectiveIds: collectiveIds,
        status: status,
        ...computeDatesAsISOStrings(startDate, endDate),
      },
      type: sequelize.QueryTypes.SELECT,
    },
  );

  return computeTotal(results, host.currency);
}

/**
 * Returns transaction amounts over time
 * Ex: [ { date: '2020-01-01', amount: 2000 }, { date: '2021-01-01', amount: 1000 }, ... ]
 */
export const getTransactionsTimeSeries = async (
  hostCollectiveId,
  timeUnit,
  { type = null, kind = null, collectiveIds = null, dateFrom = null, dateTo = null } = {},
) => {
  return sequelize.query(
    `SELECT DATE_TRUNC(:timeUnit, "createdAt") AS "date", sum("amountInHostCurrency") as "amount", "hostCurrency" as "currency"
       FROM "Transactions"
       WHERE "HostCollectiveId" = :hostCollectiveId
         AND "deletedAt" IS NULL
         ${type ? `AND "type" = :type` : ``}
         ${kind?.length ? `AND "kind" IN (:kind)` : ``}
         ${collectiveIds?.length ? `AND "CollectiveId" IN (:collectiveIds)` : ``}
         ${dateFrom ? `AND "createdAt" >= :startDate` : ``}
         ${dateTo ? `AND "createdAt" <= :endDate` : ``}
       GROUP BY DATE_TRUNC(:timeUnit, "createdAt"), "hostCurrency"
       ORDER BY DATE_TRUNC(:timeUnit, "createdAt"),
      `,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: {
        kind: Array.isArray(kind) ? kind : [kind],
        type,
        hostCollectiveId,
        timeUnit,
        collectiveIds,
        ...computeDatesAsISOStrings(dateFrom, dateTo),
      },
    },
  );
};

/**
 * Returns transaction amounts over time, grouped by kind.
 * Ex: [ { date: '2020-01-01', amount: 1000, kind: 'CONTRIBUTION' }, { date: '2020-01-01', amount: 1000, kind: 'ADDED_FUNDS' }, ... ]
 */
export const getTransactionsTimeSeriesByKind = async (
  hostCollectiveId,
  timeUnit,
  { type = null, kind = null, collectiveIds = null, dateFrom = null, dateTo = null } = {},
) => {
  return sequelize.query(
    `SELECT DATE_TRUNC(:timeUnit, "createdAt") AS "date", sum("amountInHostCurrency") as "amount", "hostCurrency" as "currency", "kind"
       FROM "Transactions"
       WHERE "HostCollectiveId" = :hostCollectiveId
         AND "deletedAt" IS NULL
         ${type ? `AND "type" = :type` : ``}
         ${kind?.length ? `AND "kind" IN (:kind)` : ``}
         ${collectiveIds?.length ? `AND "CollectiveId" IN (:collectiveIds)` : ``}
         ${dateFrom ? `AND "createdAt" >= :startDate` : ``}
         ${dateTo ? `AND "createdAt" <= :endDate` : ``}
       GROUP BY DATE_TRUNC(:timeUnit, "createdAt"), "kind", "hostCurrency"
       ORDER BY DATE_TRUNC(:timeUnit, "createdAt"), "kind"
      `,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: {
        kind: Array.isArray(kind) ? kind : [kind],
        type,
        hostCollectiveId,
        timeUnit,
        collectiveIds,
        ...computeDatesAsISOStrings(dateFrom, dateTo),
      },
    },
  );
};
