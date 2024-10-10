import '../../server/env';

import { flatten, uniq } from 'lodash';

import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runCheckThenExit } from './_utils';

async function checkTransactionsImports({ fix = false } = {}) {
  const message = 'No deadlocks found in TransactionsImports';

  const results = await sequelize.query(
    `
      SELECT id
      FROM "TransactionsImports"
      WHERE "deletedAt" IS NULL
      AND "data"->>'lockedAt' IS NOT NULL
      AND ("data"->>'lockedAt')::timestamptz < NOW() - INTERVAL '24 hour'
    `,
    { type: sequelize.QueryTypes.SELECT, raw: true },
  );

  if (results.length > 0) {
    if (!fix) {
      throw new Error(message);
    } else {
      const importIds = uniq(flatten(results.map(r => r.id)));
      logger.warn(`Fixing: ${message} for imports: ${importIds.join(', ')}`);
      await sequelize.query(
        `
        UPDATE "TransactionsImports"
        SET "data" = "data" - 'lockedAt'
        WHERE id IN (:importIds)
        `,
        { replacements: { importIds } },
      );
    }
  }
}

export async function checkDeadLocks({ fix = false } = {}) {
  await checkTransactionsImports({ fix });
}

if (!module.parent) {
  runCheckThenExit(checkDeadLocks);
}
