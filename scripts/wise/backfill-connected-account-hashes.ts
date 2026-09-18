/**
 * Backfills Wise ConnectedAccounts `hash` values to the canonical (exact decimal string) form and
 * casts `data.id` to a string.
 *
 * Before the Int64 refactor, connected-account hashes were computed from JavaScript numbers and
 * Wise ids were stored as numbers. Both are lossy and are being replaced by exact decimal strings.
 * A row can only be migrated when every hash input is recoverable from its own stored data:
 *
 * - `data.id` must be present and a safe integer, and
 * - a personal profile `userId` must be present (in `data.personalProfile.userId` or
 *   `settings.userId`) and a safe integer.
 *
 * Rows without a stored personal `userId` cannot have their hash recomputed and are skipped (their
 * `userId` is only available from Wise). Rows with unsafe ids are skipped too: their original digits
 * cannot be recovered. Skipped rows keep working through the runtime legacy-hash fallback.
 *
 * Run with:
 *   npm run script scripts/wise/backfill-connected-account-hashes.ts -- [--limit 100]
 * Dry-run by default; pass DRY_RUN=false to apply.
 */

import '../../server/env';

import { Command } from 'commander';

import { Service } from '../../server/constants/connected-account';
import logger from '../../server/lib/logger';
import { normalizeWiseId, safeLegacyNumericWiseId } from '../../server/lib/wise-id';
import models, { ConnectedAccount, sequelize } from '../../server/models';
import { hashObject } from '../../server/paymentProviders/utils';

const DRY_RUN = process.env.DRY_RUN !== 'false';

type BackfillSummary = {
  scanned: number;
  migrated: number;
  skippedMissingId: number;
  skippedMissingUserId: number;
  skippedUnsafe: number;
  isDryRun: boolean;
};

/** Reads the personal Wise profile `userId` from either supported storage location. */
const getStoredUserId = (data: Record<string, unknown>, settings: Record<string, unknown>): unknown => {
  return data?.personalProfile?.['userId'] ?? settings?.['userId'];
};

/**
 * Returns the canonical hash and stringified `data.id` for a migratable row, or `null` when the row
 * must be skipped. Inspect the returned `skipReason` to tell the cases apart.
 */
const planMigration = (
  account: ConnectedAccount,
): { hash: string; dataId: string } | { skipReason: 'missingId' | 'missingUserId' | 'unsafe' } => {
  const data = (account.data ?? {}) as Record<string, unknown>;
  const settings = (account.settings ?? {}) as Record<string, unknown>;
  const storedId = data.id;
  if (storedId === undefined || storedId === null || storedId === '') {
    return { skipReason: 'missingId' };
  }

  const userId = getStoredUserId(data, settings);
  if (userId === undefined || userId === null || userId === '') {
    return { skipReason: 'missingUserId' };
  }

  // Both ids must be safe integers so the legacy fingerprint we are replacing was not already
  // rounded. `safeLegacyNumericWiseId` returns undefined for anything unsafe.
  const profileId = safeLegacyNumericWiseId(storedId);
  const numericUserId = safeLegacyNumericWiseId(userId);
  if (profileId === undefined || numericUserId === undefined) {
    return { skipReason: 'unsafe' };
  }

  return {
    dataId: normalizeWiseId(storedId),
    hash: hashObject({
      profileId: normalizeWiseId(storedId),
      service: Service.TRANSFERWISE,
      userId: normalizeWiseId(userId),
    }),
  };
};

export const backfillConnectedAccountHashes = async ({
  isDryRun,
  limit,
}: {
  isDryRun: boolean;
  limit?: number;
}): Promise<BackfillSummary> => {
  const summary: BackfillSummary = {
    scanned: 0,
    migrated: 0,
    skippedMissingId: 0,
    skippedMissingUserId: 0,
    skippedUnsafe: 0,
    isDryRun,
  };

  const accounts = await models.ConnectedAccount.findAll({
    // Filter `deletedAt` explicitly rather than relying on the paranoid scope: soft-deleted
    // accounts must never be rewritten.
    where: { service: Service.TRANSFERWISE, deletedAt: null },
    order: [['id', 'ASC']],
    ...(limit ? { limit } : {}),
  });

  for (const account of accounts) {
    summary.scanned++;
    const plan = planMigration(account);
    if ('skipReason' in plan) {
      if (plan.skipReason === 'missingId') {
        summary.skippedMissingId++;
      } else if (plan.skipReason === 'missingUserId') {
        summary.skippedMissingUserId++;
      } else {
        summary.skippedUnsafe++;
      }
      continue;
    }

    if (plan.hash === account.hash && plan.dataId === account.data?.id) {
      // Already canonical, nothing to do
      continue;
    }

    summary.migrated++;
    if (!isDryRun) {
      await account.update({ hash: plan.hash, data: { ...account.data, id: plan.dataId } });
    }
  }

  return summary;
};

const program = new Command();
program.option('--limit <number>', 'Limit the number of connected accounts to process', parseInt);
program.action(async options => {
  console.log(`Starting Wise connected-account hash backfill (DRY_RUN: ${DRY_RUN})...`);
  const summary = await backfillConnectedAccountHashes({ isDryRun: DRY_RUN, limit: options.limit });
  console.log(`Summary: ${JSON.stringify(summary)}`);
  await sequelize.close();
});

if (!module.parent) {
  program
    .parseAsync()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      logger.error(e.toString());
      process.exit(1);
    });
}
