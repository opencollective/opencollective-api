import '../../server/env';

import { QueryTypes } from 'sequelize';

import { formatAddress } from '../../server/lib/format-address';
import logger from '../../server/lib/logger';
import { sequelize } from '../../server/models';

import { runAllChecksThenExit } from './_utils';

// The five fields that formatAddress reads from structured. At least one must hold a non-empty
// string value for the row to be considered fixable.
const STRUCTURED_HAS_FORMATTABLE_DATA = `
  (
    (structured->>'address1'   IS NOT NULL AND structured->>'address1'   != '')
    OR (structured->>'address2'   IS NOT NULL AND structured->>'address2'   != '')
    OR (structured->>'city'       IS NOT NULL AND structured->>'city'       != '')
    OR (structured->>'zone'       IS NOT NULL AND structured->>'zone'       != '')
    OR (structured->>'postalCode' IS NOT NULL AND structured->>'postalCode' != '')
  )
`;

const BATCH_SIZE = 1000;

async function checkLocationsWithMissingAddress({ fix = false } = {}) {
  const message = 'Locations with structured data but missing formatted address';

  const countResults = await sequelize.query<{ count: string }>(
    `
    SELECT COUNT(*) AS count
    FROM "Locations"
    WHERE "deletedAt" IS NULL
      AND "structured" IS NOT NULL
      AND ("address" IS NULL OR "address" = '')
      AND ${STRUCTURED_HAS_FORMATTABLE_DATA}
    `,
    { type: QueryTypes.SELECT, raw: true },
  );

  const count = Number(countResults[0].count);
  if (count === 0) {
    return;
  }

  if (!fix) {
    throw new Error(`${message} (found ${count})`);
  }

  logger.warn(`Fixing: ${message} (${count} affected row(s))`);

  let fixed = 0;
  let skipped = 0;
  let lastId = 0;
  while (true) {
    const batch = await sequelize.query<{
      id: number;
      country: string | null;
      structured: Record<string, string> | null;
    }>(
      `
      SELECT id, country, structured
      FROM "Locations"
      WHERE "deletedAt" IS NULL
        AND "structured" IS NOT NULL
        AND ("address" IS NULL OR "address" = '')
        AND ${STRUCTURED_HAS_FORMATTABLE_DATA}
        AND id > :lastId
      ORDER BY id
      LIMIT :batchSize
      `,
      { type: QueryTypes.SELECT, raw: true, replacements: { lastId, batchSize: BATCH_SIZE } },
    );

    if (batch.length === 0) {
      break;
    }

    for (const location of batch) {
      const address = await formatAddress({ structured: location.structured, country: location.country });

      if (address) {
        await sequelize.query(`UPDATE "Locations" SET address = :address, "updatedAt" = NOW() WHERE id = :id`, {
          replacements: { address, id: location.id },
          type: QueryTypes.UPDATE,
        });
        fixed++;
      } else {
        // structured exists but holds no formattable content — leave the row as-is
        logger.warn(`Location #${location.id}: could not derive a formatted address from structured data, skipping`);
        skipped++;
      }
    }

    lastId = batch[batch.length - 1].id;
  }

  logger.info(
    `Fixed: regenerated address on ${fixed} Location(s)${skipped ? `, skipped ${skipped} (no formattable data)` : ''}`,
  );
}

export const checks = [checkLocationsWithMissingAddress];

if (!module.parent) {
  runAllChecksThenExit(checks);
}
