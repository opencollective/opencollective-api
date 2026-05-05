import '../../server/env';

import assert from 'assert';

import { Command } from 'commander';
import { toNumber } from 'lodash';
import moment from 'moment';
import { QueryTypes } from 'sequelize';

import { getHostReportNodesFromQueryResult } from '../../server/lib/transaction-reports';
import models, { sequelize } from '../../server/models';

const program = new Command();

const query = dateField => {
  dateField = dateField === 'effective' ? `COALESCE(t."clearedAt", t."createdAt")` : `t."createdAt"`;
  return `
  WITH "HostMonthlyTransactions" AS (SELECT DATE_TRUNC('month', ${dateField} AT TIME ZONE 'UTC')              AS "date",
                                         t."HostCollectiveId",
                                         SUM(t."amountInHostCurrency")                                         AS "amountInHostCurrency",
                                         SUM(COALESCE(t."platformFeeInHostCurrency", 0))                       AS "platformFeeInHostCurrency",
                                         SUM(COALESCE(t."hostFeeInHostCurrency", 0))                           AS "hostFeeInHostCurrency",
                                         SUM(COALESCE(t."paymentProcessorFeeInHostCurrency", 0))               AS "paymentProcessorFeeInHostCurrency",
                                         SUM(COALESCE(t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1), 0)) AS "taxAmountInHostCurrency",
                                         COALESCE(
                                                 SUM(COALESCE(t."amountInHostCurrency", 0))
                                                     + SUM(COALESCE(t."platformFeeInHostCurrency", 0))
                                                     + SUM(COALESCE(t."hostFeeInHostCurrency", 0))
                                                     + SUM(COALESCE(t."paymentProcessorFeeInHostCurrency", 0))
                                                     +
                                                 SUM(COALESCE(t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1), 0)),
                                                 0
                                         )                                                                     AS "netAmountInHostCurrency",
                                         t."kind",
                                         t."isRefund",
                                         t."hostCurrency",
                                         t."type",
                                         CASE
                                             WHEN t."CollectiveId" = t."HostCollectiveId" THEN TRUE
                                             WHEN EXISTS (SELECT 1
                                             FROM "Collectives" c
                                             WHERE c."id" = t."CollectiveId"
                                               AND c."ParentCollectiveId" = t."HostCollectiveId"
                                               AND c."type" != 'VENDOR') THEN TRUE
                                             ELSE FALSE
                                             END                                                               AS "isHost",
                                         e."type"                                                              AS "expenseType",
                                         NOW()                                                                 AS "refreshedAt"
  FROM "Transactions" t
           LEFT JOIN LATERAL (
      SELECT e2."type" FROM "Expenses" e2 WHERE e2.id = t."ExpenseId"
      ) AS e ON t."ExpenseId" IS NOT NULL
  WHERE t."deletedAt" IS NULL
    AND t."HostCollectiveId" = :hostCollectiveId
  GROUP BY DATE_TRUNC('month', ${dateField} AT TIME ZONE 'UTC'), t."HostCollectiveId", t."kind", t."hostCurrency",
      t."isRefund", t."type", "isHost", "expenseType"
  ORDER BY "date", t."HostCollectiveId", t."kind"),
      CombinedData AS (SELECT DATE_TRUNC(:timeUnit, "date" AT TIME ZONE 'UTC') AS "date",
                           "HostCollectiveId",
                           "amountInHostCurrency",
                           "platformFeeInHostCurrency",
                           "hostFeeInHostCurrency",
                           "paymentProcessorFeeInHostCurrency",
                           "taxAmountInHostCurrency",
                           "netAmountInHostCurrency",
                           "kind",
                           "isRefund",
                           "hostCurrency",
                           "type",
                           "isHost",
                           "expenseType"
      FROM "HostMonthlyTransactions"
      WHERE "HostCollectiveId" = :hostCollectiveId
        AND date <= :dateTo)
  SELECT "date",
      "isRefund",
      "isHost",
      "kind",
      "type",
      "expenseType",
      "hostCurrency",
      SUM("platformFeeInHostCurrency")         AS "platformFeeInHostCurrency",
      SUM("hostFeeInHostCurrency")             AS "hostFeeInHostCurrency",
      SUM("paymentProcessorFeeInHostCurrency") AS "paymentProcessorFeeInHostCurrency",
      SUM("taxAmountInHostCurrency")           AS "taxAmountInHostCurrency",
      SUM("netAmountInHostCurrency")           AS "netAmountInHostCurrency",
      SUM("amountInHostCurrency")              AS "amountInHostCurrency"
  FROM CombinedData
  GROUP BY "date",
      "isRefund",
      "isHost",
      "kind",
      "type",
      "expenseType",
      "hostCurrency"
  ORDER BY "date";
  `;
};

program
  .command('generate <period> <hostId> <from> <to> [dateField] [env]')
  .action(async (period, hostId, from, to, dateField = 'createdAt') => {
    console.log('Generating report for host', hostId, 'from', from, 'to', to, 'dateField', dateField);
    const host = await models.Collective.findByPk(toNumber(hostId));
    assert(['month', 'quarter', 'year'].includes(period), 'Invalid period, must be month, quarter or year');
    assert(host, 'Host not found');

    const queryResult = await sequelize.query(query(dateField), {
      replacements: {
        hostCollectiveId: toNumber(hostId),
        timeUnit: period,
        dateTo: moment(to).utc().toISOString(),
      },
      type: QueryTypes.SELECT,
      raw: true,
    });

    const nodes = await getHostReportNodesFromQueryResult({
      queryResult,
      dateFrom: from,
      dateTo: to,
      timeUnit: period,
      currency: host.currency,
    });

    console.dir(nodes, { depth: null });
    sequelize.close();
  });

program.addHelpText(
  'after',
  `
This script generates a report of the transactions for a given host and period. It can be used to generate reports for the dashboard or for other purposes.

Usage:
  node scripts/accounting/generate-host-report.js generate <period> <hostId> <from> <to> [createdAt|effective] [env]

Example:
  node scripts/accounting/generate-host-report.js generate month 11004 2022-01-01 2022-12-31 effective
`,
);

program.parse();
