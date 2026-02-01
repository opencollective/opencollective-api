import '../../server/env';

import { sql } from '@ts-safeql/sql-tag';
import { flatten, uniq } from 'lodash';
import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

async function checkTransactionsImports({ fix = false } = {}) {
  const message = 'No deadlocks found in TransactionsImports';

  const results = await sequelize.query<{ id: number }>(
    sql`
      SELECT id
      FROM "TransactionsImports"
      WHERE "deletedAt" IS NULL
      AND "data"->>'lockedAt' IS NOT NULL
      AND ("data"->>'lockedAt')::timestamptz < NOW() - INTERVAL '24 hour'
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      const importIds = uniq(flatten(results.map(r => r.id)));
      logger.warn(`Fixing: ${message} for imports: ${importIds.join(', ')}`);
      await sequelize.query(
        sql`
        UPDATE "TransactionsImports"
        SET "data" = "data" - 'lockedAt'
        WHERE id = ANY(${importIds}::int[])
        `,
      );
    }
  }
}

export const checks = [checkTransactionsImports];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
