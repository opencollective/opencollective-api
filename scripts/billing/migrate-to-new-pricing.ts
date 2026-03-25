/**
 * This script migrates hosts with legacy plans to the new PlatformSubscription pricing.
 *
 * Timeline: Switch on April 1st 2026, first invoice on May 1st 2026.
 *
 * The MIGRATION_LIST below drives the migration:
 *  - Entries with `tier: 'NONE'` are skipped (pending discussions, closing accounts, etc.)
 *  - Entries with a tier ID get that tier, optionally with plan overrides deep-merged on top.
 *  - Hosts with a legacy plan NOT present in the list default to `discover-1`.
 *
 * Usage:
 *   # Dry run (default) — summarises changes without applying them
 *   npx ts-node scripts/billing/migrate-to-new-pricing.ts
 *
 *   # Live run
 *   DRY_RUN=false npx ts-node scripts/billing/migrate-to-new-pricing.ts
 */

import { merge } from 'lodash';
import { Op } from 'sequelize';

import { PlatformSubscriptionPlan, PlatformSubscriptionTiers } from '../../server/constants/plans';
import logger from '../../server/lib/logger';
import PlatformConstants from '../../server/constants/platform';
import models, { PlatformSubscription } from '../../server/models';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MigrationEntry = {
  slug: string;
  /** ID from PlatformSubscriptionTiers (e.g. 'basic-10'), or 'NONE' to skip this account. */
  tier: string | 'NONE';
  /** Optional partial overrides merged on top of the resolved tier plan, or 'NONE' when tier is 'NONE'. */
  plan: Partial<Pick<PlatformSubscriptionPlan, 'pricing' | 'features'>> | 'NONE';
};

// ─── Migration configuration ─────────────────────────────────────────────────

export const MIGRATION_START_DATE = new Date('2026-04-01T00:00:00Z');

export const DEFAULT_TIER_ID = 'discover-1';

/**
 * Fill in this list before running. Each entry is keyed by the organisation slug.
 *
 * Accounts NOT listed here will be migrated to `discover-1` by default.
 */
const MIGRATION_LIST: MigrationEntry[] = [
  // Examples:
  // { slug: 'some-host', tier: 'basic-10', plan: {} },
  // { slug: 'another-host', tier: 'pro-20', plan: { pricing: { pricePerMonth: 28000 } } },
  // { slug: 'skip-me', tier: 'NONE', plan: 'NONE' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function resolvePlan(entry: MigrationEntry | undefined): Partial<PlatformSubscriptionPlan> {
  const tierId = entry?.tier ?? DEFAULT_TIER_ID;
  const catalogTier = PlatformSubscriptionTiers.find(t => t.id === tierId);
  if (!catalogTier) {
    throw new Error(
      `Unknown tier ID: "${tierId}". Must be one of: ${PlatformSubscriptionTiers.map(t => t.id).join(', ')}`,
    );
  }
  const base: Partial<PlatformSubscriptionPlan> = { ...catalogTier };
  if (entry?.plan && entry.plan !== 'NONE') {
    return merge({}, base, entry.plan);
  }
  return base;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function main(
  opts: {
    dryRun?: boolean;
    migrationList?: MigrationEntry[];
    startDate?: Date;
  } = {},
) {
  const dryRun = opts.dryRun ?? process.env.DRY_RUN !== 'false';
  const migrationList = opts.migrationList ?? MIGRATION_LIST;
  const startDate = opts.startDate ?? MIGRATION_START_DATE;

  logger.info(`=== Pricing migration script ===`);
  logger.info(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE RUN'}`);
  logger.info(`Migration start date: ${startDate.toISOString()}`);

  // 1. Resolve system user
  const systemUser = await models.User.findByPk(PlatformConstants.PlatformUserId);
  if (!systemUser) {
    throw new Error(`System user not found (id: ${PlatformConstants.PlatformUserId})`);
  }

  // 2. Load all legacy hosts (Collective.plan IS NOT NULL, excluding first-party hosts)
  const allLegacyHosts = await models.Collective.findAll({
    where: {
      plan: { [Op.not]: null },
      deletedAt: null,
    },
  });

  const legacyHosts = allLegacyHosts.filter(h => !h.data?.isFirstPartyHost);

  logger.info(
    `Found ${allLegacyHosts.length} legacy hosts total, ${allLegacyHosts.length - legacyHosts.length} skipped (isFirstPartyHost), ${legacyHosts.length} to evaluate.`,
  );

  // 3. Validate migrationList entries against DB and tier catalog
  const hostsBySlug = new Map(legacyHosts.map(h => [h.slug, h]));
  for (const entry of migrationList) {
    if (!hostsBySlug.has(entry.slug)) {
      logger.warn(`MIGRATION_LIST warning: slug "${entry.slug}" not found among legacy hosts.`);
    }
    if (entry.tier !== 'NONE' && !PlatformSubscriptionTiers.find(t => t.id === entry.tier)) {
      logger.warn(`MIGRATION_LIST warning: tier "${entry.tier}" for slug "${entry.slug}" is not a valid tier ID.`);
    }
  }

  const migrationBySlug = new Map(migrationList.map(e => [e.slug, e]));

  // 4. Build migration plan
  type MigrationAction =
    | { kind: 'skip'; host: (typeof legacyHosts)[number]; reason: string }
    | { kind: 'migrate'; host: (typeof legacyHosts)[number]; resolvedPlan: Partial<PlatformSubscriptionPlan> };

  const actions: MigrationAction[] = [];

  for (const host of legacyHosts) {
    const entry = migrationBySlug.get(host.slug);
    if (entry?.tier === 'NONE') {
      actions.push({
        kind: 'skip',
        host,
        reason: 'Listed as NONE in MIGRATION_LIST (pending discussion / closing account)',
      });
      continue;
    }
    try {
      const resolvedPlan = resolvePlan(entry);
      actions.push({ kind: 'migrate', host, resolvedPlan });
    } catch (err) {
      logger.error(`Error resolving plan for @${host.slug}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 5. Print summary
  const toMigrate = actions.filter(a => a.kind === 'migrate') as Extract<MigrationAction, { kind: 'migrate' }>[];
  const toSkip = actions.filter(a => a.kind === 'skip') as Extract<MigrationAction, { kind: 'skip' }>[];

  logger.info(`── To migrate (${toMigrate.length}) ──────────────────────────`);
  for (const action of toMigrate) {
    const entry = migrationBySlug.get(action.host.slug);
    const tierId = entry?.tier ?? DEFAULT_TIER_ID;
    const isDefault = !entry;
    logger.info(
      `  @${action.host.slug.padEnd(40)} legacy: ${String(action.host.plan).padEnd(25)} → ${tierId}${isDefault ? ' (default)' : ''}`,
    );
  }

  logger.info(`── To skip (${toSkip.length}) ────────────────────────────────`);
  for (const action of toSkip) {
    logger.info(`  @${action.host.slug.padEnd(40)} ${action.reason}`);
  }

  if (dryRun) {
    logger.info('Dry run complete. Set DRY_RUN=false to apply changes.');
    return { migrated: 0, skipped: toSkip.length, errors: 0 };
  }

  // 6. Apply migrations
  let migrated = 0;
  let errors = 0;

  for (const action of toMigrate) {
    try {
      await PlatformSubscription.replaceCurrentSubscription(action.host, startDate, action.resolvedPlan, systemUser, {
        isAutomaticMigration: true,
      });

      await action.host.update({
        plan: null,
        settings: {
          ...action.host.settings,
          automaticBillingMigration: startDate,
        },
      });

      logger.info(`Migrated @${action.host.slug}`);
      migrated++;
    } catch (err) {
      logger.error(`Failed to migrate @${action.host.slug}: ${err instanceof Error ? err.message : err}`);
      errors++;
    }
  }

  logger.info(`=== Done. Migrated: ${migrated}, Skipped: ${toSkip.length}, Errors: ${errors} ===`);
  return { migrated, skipped: toSkip.length, errors };
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch(err => {
      logger.error(err);
      process.exit(1);
    });
}
