import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { sequelize } from '../../models';

type TransactionsImportStats = {
  total: number;
  processed: number;
  imported: number;
  ignored: number;
  onHold: number;
  expenses: number;
  orders: number;
  pending: number;
  invalid: number;
};

export const generateTransactionsImportStatsLoader = () => {
  return new DataLoader(async (importIds: number[]): Promise<TransactionsImportStats[]> => {
    const results: Partial<TransactionsImportStats>[] = await sequelize.query(
      `
      SELECT
        row."TransactionsImportId",
        COUNT(row.id) AS total,
        COUNT(row.id) FILTER (WHERE "status" = 'IGNORED' OR "status" = 'LINKED') AS processed,
        COUNT(row.id) FILTER (WHERE "status" = 'LINKED') AS imported,
        COUNT(row.id) FILTER (WHERE "status" = 'LINKED' AND "ExpenseId" IS NULL AND "OrderId" IS NULL) AS invalid,
        COUNT(row.id) FILTER (WHERE "status" = 'IGNORED') AS ignored,
        COUNT(row.id) FILTER (WHERE "status" = 'ON_HOLD') AS "onHold",
        COUNT(row.id) FILTER (WHERE "ExpenseId" IS NOT NULL) AS expenses,
        COUNT(row.id) FILTER (WHERE "OrderId" IS NOT NULL) AS orders,
        COUNT(row.id) FILTER (WHERE "status" = 'PENDING') AS pending
      FROM "TransactionsImportsRows" row
      WHERE row."TransactionsImportId" IN (:importIds)
      GROUP BY row."TransactionsImportId"
      `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { importIds },
      },
    );

    const groupedResults = groupBy(results, 'TransactionsImportId');
    return importIds.map(importId => {
      const result = groupedResults[importId]?.[0] || {};
      return {
        total: result['total'] || 0,
        ignored: result['ignored'] || 0,
        imported: result['imported'] || 0,
        expenses: result['expenses'] || 0,
        orders: result['orders'] || 0,
        processed: result['processed'] || 0,
        pending: result['pending'] || 0,
        onHold: result['onHold'] || 0,
        invalid: result['invalid'] || 0,
      };
    });
  });
};

export const generateOffPlatformTransactionsStatsLoader = () => {
  return new DataLoader(async (hostIds: number[]): Promise<TransactionsImportStats[]> => {
    const results: Partial<TransactionsImportStats>[] = await sequelize.query(
      `
      SELECT
        ti."CollectiveId",
        COUNT(row.id) AS total,
        COUNT(row.id) FILTER (WHERE "status" = 'IGNORED' OR "status" = 'LINKED') AS processed,
        COUNT(row.id) FILTER (WHERE "status" = 'LINKED') AS imported,
        COUNT(row.id) FILTER (WHERE "status" = 'LINKED' AND "ExpenseId" IS NULL AND "OrderId" IS NULL) AS invalid,
        COUNT(row.id) FILTER (WHERE "status" = 'IGNORED') AS ignored,
        COUNT(row.id) FILTER (WHERE "status" = 'ON_HOLD') AS "onHold",
        COUNT(row.id) FILTER (WHERE "ExpenseId" IS NOT NULL) AS expenses,
        COUNT(row.id) FILTER (WHERE "OrderId" IS NOT NULL) AS orders,
        COUNT(row.id) FILTER (WHERE "status" = 'PENDING') AS pending
      FROM "TransactionsImportsRows" row
      INNER JOIN "TransactionsImports" ti ON ti.id = row."TransactionsImportId"
      WHERE ti."CollectiveId" IN (:hostIds)
      AND ti."type" = 'PLAID'
      GROUP BY ti."CollectiveId"
      `,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: { hostIds },
      },
    );

    const groupedResults = groupBy(results, 'CollectiveId');
    return hostIds.map(hostId => {
      const result = groupedResults[hostId]?.[0] || ({} as Partial<TransactionsImportStats>);
      return {
        total: result.total || 0,
        ignored: result.ignored || 0,
        imported: result.imported || 0,
        expenses: result.expenses || 0,
        orders: result.orders || 0,
        processed: result.processed || 0,
        pending: result.pending || 0,
        onHold: result.onHold || 0,
        invalid: result.invalid || 0,
      };
    });
  });
};
