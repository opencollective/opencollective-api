import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { sequelize } from '../../models';

type TransactionsImportStats = {
  total: number;
  ignored: number;
  expenses: number;
  orders: number;
  processed: number;
};

export const generateTransactionsImportStatsLoader = () => {
  return new DataLoader(async (importIds: number[]): Promise<TransactionsImportStats[]> => {
    const results: { total: number; processed: number }[] = await sequelize.query(
      `
      SELECT
        row."TransactionsImportId",
        COUNT(row.id) AS total,
        COUNT(row.id) FILTER (WHERE "isDismissed" IS TRUE OR "ExpenseId" IS NOT NULL OR "OrderId" IS NOT NULL) AS processed,
        COUNT(row.id) FILTER (WHERE "isDismissed" IS TRUE) AS ignored,
        COUNT(row.id) FILTER (WHERE "ExpenseId" IS NOT NULL) AS expenses,
        COUNT(row.id) FILTER (WHERE "OrderId" IS NOT NULL) AS orders
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
        expenses: result['expenses'] || 0,
        orders: result['orders'] || 0,
        processed: result['processed'] || 0,
      };
    });
  });
};
