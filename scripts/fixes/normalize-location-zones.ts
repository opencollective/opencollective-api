import '../../server/env';

import { Command } from 'commander';
import { QueryTypes } from 'sequelize';

import { formatAddress } from '../../server/lib/format-address';
import logger from '../../server/lib/logger';
import { normalizeZoneCode } from '../../server/lib/normalize-zone';
import { sequelize } from '../../server/models';

const BATCH_SIZE = 1000;

type LocationRow = {
  id: number;
  country: string | null;
  structured: Record<string, string> | null;
  address: string | null;
};

async function normalizeLocationZones({ dryRun = false } = {}) {
  let lastId = 0;
  let updated = 0;
  let skipped = 0;

  while (true) {
    const batch = await sequelize.query<LocationRow>(
      `
      SELECT id, country, structured, address
      FROM "Locations"
      WHERE "deletedAt" IS NULL
        AND structured IS NOT NULL
        AND structured->>'zone' IS NOT NULL
        AND structured->>'zone' != ''
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
      const zone = location.structured?.zone;
      const normalizedZone = normalizeZoneCode(location.country, zone);

      if (!normalizedZone || normalizedZone === zone) {
        skipped++;
        continue;
      }

      const structured = { ...location.structured, zone: normalizedZone };
      const address = await formatAddress({ structured, country: location.country });

      if (dryRun) {
        logger.info(`Location #${location.id}: zone "${zone}" -> "${normalizedZone}"`);
      } else {
        await sequelize.query(
          `
          UPDATE "Locations"
          SET structured = :structured::jsonb, address = :address
          WHERE id = :id
          `,
          {
            replacements: {
              structured: JSON.stringify(structured),
              address,
              id: location.id,
            },
            type: QueryTypes.UPDATE,
          },
        );
      }

      updated++;
    }

    lastId = batch[batch.length - 1].id;
  }

  logger.info(
    `${dryRun ? 'Would update' : 'Updated'} ${updated} Location(s) with normalized zone codes (${skipped} unchanged)`,
  );
}

function parseCommandLineArguments() {
  const program = new Command().option('--dry-run', 'Log changes without writing to the database').parse(process.argv);

  return program.opts<{ dryRun?: boolean }>();
}

if (require.main === module) {
  const options = parseCommandLineArguments();
  normalizeLocationZones(options)
    .then(() => process.exit(0))
    .catch(error => {
      logger.error(error);
      process.exit(1);
    });
}
