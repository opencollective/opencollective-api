/**
 * This script migrates hosts with legacy plans to the new PlatformSubscription pricing.
 *
 * Timeline: Switch on April 1st 2026, first invoice on May 1st 2026.
 *
 * `SPECIAL_MIGRATION_LIST` below drives per-host tier targets (others default to `discover-1`):
 *  - Entries with `tier: 'NONE'` are skipped (pending discussions, closing accounts, etc.)
 *  - Entries with a tier ID get that tier, optionally with plan overrides deep-merged on top.
 *  - Hosts with a legacy plan NOT present in the list default to `discover-1`.
 *
 * Usage:
 *   # Dry run (default) — summarises changes without applying them
 *   npx ts-node scripts/billing/migrate-to-new-pricing.ts
 *
 *   # Live run (migrates; inactive hosts are listed but money management is not disabled unless flagged)
 *   DRY_RUN=false npx ts-node scripts/billing/migrate-to-new-pricing.ts
 *
 *   # Live run and disable money management for inactive hosts (no transactions in 12 months, not on list)
 *   DRY_RUN=false npx ts-node scripts/billing/migrate-to-new-pricing.ts --inactive-disable-money-management
 *
 *   # Partial runs (full plan is still logged above; filters apply to migration / disable-MM execution)
 *   npx ts-node scripts/billing/migrate-to-new-pricing.ts --limit 5
 *   npx ts-node scripts/billing/migrate-to-new-pricing.ts --onlySlugs my-host,other-host
 *   npx ts-node scripts/billing/migrate-to-new-pricing.ts --excludeSlugs noisy-host
 */

import '../../server/env';

import { Command } from 'commander';
import { sql } from 'kysely';
import { merge } from 'lodash';
import moment from 'moment';

import { CollectiveType } from '../../server/constants/collectives';
import PlatformFeature from '../../server/constants/feature';
import { PlatformSubscriptionPlan, PlatformSubscriptionTiers } from '../../server/constants/plans';
import { getKysely, kyselyToSequelizeModels } from '../../server/lib/kysely';
import logger from '../../server/lib/logger';
import { Collective, PlatformSubscription, sequelize } from '../../server/models';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MigrationEntry = {
  slug: string;
  plan:
    | null
    | Pick<PlatformSubscriptionPlan, 'id'>
    | (Pick<PlatformSubscriptionPlan, 'basePlanId'> & {
        pricing: Partial<PlatformSubscriptionPlan['pricing']>;
        features: Partial<PlatformSubscriptionPlan['features']>;
      });
};

// ─── Migration configuration ─────────────────────────────────────────────────

const MIGRATION_START_DATE = new Date('2026-04-01T00:00:00Z');

const DEFAULT_TIER_ID = 'discover-1';

// A special plan that we've agreed upon with many organizations
const SPECIAL_PLAN_BASIC_30: MigrationEntry['plan'] = {
  basePlanId: 'basic-5',
  pricing: { pricePerMonth: 3000, includedCollectives: 1, includedExpensesPerMonth: 10 },
  features: {},
};

/**
 * Per-host tier targets from `scripts/billing/feedback.csv` (snapshot; CSV not loaded at runtime).
 *
 * Accounts NOT listed here will be migrated to `discover-1` by default.
 *
 * Use plan: null to skip the account.
 */
export const SPECIAL_MIGRATION_LIST: MigrationEntry[] = [
  // ── SCAM / closing ───────────────────────────────────────────────────────────
  { slug: 'desorden-d1337-cybersecurity', plan: null }, // Scam account.

  // On hold => do not migrate
  { slug: 'workersrevcollective', plan: null },
  { slug: 'foreningen-granslandet', plan: null },
  { slug: 'access2perspectives', plan: null },
  { slug: 'mission-forward1', plan: null },
  { slug: 'pwgd', plan: null },
  { slug: 'css', plan: null },
  { slug: 'biowoborders', plan: null },
  { slug: 'allforclimate', plan: null },
  { slug: 'democracyearth-host', plan: null },
  { slug: 'open-food-network-uk', plan: null },
  { slug: 'galan-initiative-ksh', plan: null },
  { slug: 'ferrous-systems-gmbh', plan: null }, // Plan/price TBC — Shannon to double check
  { slug: 'themuseumofhumanachievement', plan: null }, // Pro plan at basic price — to be confirmed with Shannon
  { slug: 'massvis', plan: null }, // Waiting for Shannon's input
  { slug: 'thirty-percy', plan: null }, // Waiting for Shannon's input

  // Pro
  { slug: 'metagov', plan: { id: 'pro-20' } },
  { slug: 'citizenspring-asbl', plan: { id: 'pro-20' } },
  { slug: 'vcs-academy', plan: { id: 'pro-20' } },
  { slug: 'harmonyuk', plan: { id: 'pro-20' } },
  { slug: 'ops-association', plan: { id: 'pro-20' } },

  // Basic 20 / 10
  { slug: 'socialist-rifle-association', plan: { id: 'basic-20' } },
  { slug: 'platform6-coop', plan: { id: 'basic-10' } },

  // Discover 20 / 10
  { slug: 'numfocus', plan: { id: 'discover-20' } },
  { slug: 'gatherfor-org', plan: { id: 'discover-10' } },

  // Basic 5
  { slug: 'permaculture-association', plan: { id: 'basic-5' } },
  { slug: 'chicago-community-arts-studio', plan: { id: 'basic-5' } },
  { slug: 'collective-action', plan: { id: 'basic-5' } },
  { slug: 'dosecrets', plan: { id: 'basic-5' } },
  { slug: 'earth-arts', plan: { id: 'basic-5' } },
  { slug: 'empowerment-works', plan: { id: 'basic-5' } },
  { slug: 'finalesfunkeln', plan: { id: 'basic-5' } },
  { slug: 'grayarea', plan: { id: 'basic-5' } },
  { slug: 'keep-austin-neighborly1', plan: { id: 'basic-5' } },
  { slug: 'muslimbc', plan: { id: 'basic-5' } },
  { slug: 'nmccap', plan: { id: 'basic-5' } },
  { slug: 'osgeo-foundation', plan: { id: 'basic-5' } },
  { slug: 'out4s', plan: { id: 'basic-5' } },
  { slug: 'plymouthoctopus', plan: { id: 'basic-5' } },
  { slug: 'psl-foundation', plan: { id: 'basic-5' } },
  { slug: 'reculture', plan: { id: 'basic-5' } },
  { slug: 'supabase', plan: { id: 'basic-5' } },
  { slug: 'estraperlo-scoop', plan: { id: 'basic-5' } },
  { slug: 'evilmartians', plan: { id: 'basic-5' } },
  { slug: 'foodandsolidarity', plan: { id: 'basic-5' } },
  { slug: 'hyphacoopinc', plan: { id: 'basic-5' } },
  { slug: 'pentakly', plan: { id: 'basic-5' } },
  { slug: 'superbloom', plan: { id: 'basic-5' } },
  { slug: 'wildseed-society', plan: { id: 'basic-5' } },
  { slug: 'dreamside-digital', plan: { id: 'basic-5' } },
  { slug: 'strike-for-our-rights', plan: { id: 'basic-5' } },
  { slug: 'lcl', plan: { id: 'basic-5' } },
  { slug: 'naarprdfw', plan: { id: 'basic-5' } },
  { slug: 'offensiveconf', plan: { id: 'basic-5' } },
  { slug: 'organize_hayward', plan: { id: 'basic-5' } },

  // Discover 5
  { slug: 'lucy-parsons-labs', plan: { id: 'discover-5' } },

  // Basic $30/mo (custom price on Basic-shaped tier)
  { slug: 'ppy', plan: SPECIAL_PLAN_BASIC_30 },
  {
    slug: 'huddlecraft',
    plan: {
      basePlanId: 'basic-5',
      pricing: { pricePerMonth: 3000, includedCollectives: 3, includedExpensesPerMonth: 30 },
      features: {},
    },
  },
  { slug: 'codaqui', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'amethyst-foundation', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'andileco-llc', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'arkansas-cinema-society', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'catenarymaps', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'codeops-llc', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'cohort-8-wellness-fund', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'democratic-socialists-yp', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'evolution-x', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'ledbycommunity', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'luna-red', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'redriverdrn', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'rochesterenablelimited', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'sjcmadison', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'swingdancecoop', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'tia-chuchas', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'vermont-employee-ownership-center', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'amplify-philly', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'apesa', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'chhoundevid', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'codinggrace-foundation', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'colab-foundation', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'ecobytes', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'eurd', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'fantapolitica', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'followsbusiness', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'homies-love', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'laboratoryb', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'openaustin', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'rebel-asbl', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'shared-horizons', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'the-good-shift-co', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'tudor-nora-collective', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'xdebugorg', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'uniteddiversity', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'blacksky', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'cooperation-milwaukee', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'holoapac', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'islandculturez', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'lighthouse', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'mariposasrebeldes', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'sauna-time', plan: SPECIAL_PLAN_BASIC_30 },
  { slug: 'solarpunksurfclub', plan: SPECIAL_PLAN_BASIC_30 },

  // Discover 1 (incl. $0 / low headline prices — same catalog tier)
  { slug: 'software-makers', plan: { id: 'discover-1' } },
  { slug: 'nixos_org', plan: { id: 'discover-1' } },
  { slug: 'reproductive-rights-coalition', plan: { id: 'discover-1' } },
  { slug: 'worldiadayinc', plan: { id: 'discover-1' } },
  { slug: 'blisslabs', plan: { id: 'discover-1' } },
  { slug: 'bcc-tucson', plan: { id: 'discover-1' } },
  { slug: 'nfsc', plan: { id: 'discover-1' } },
  { slug: 'fediverse-communications', plan: { id: 'discover-1' } },
  { slug: 'codenplay', plan: { id: 'discover-1' } },
  { slug: 'youthpowercoalition', plan: { id: 'discover-1' } },
  { slug: 'heimdall-intranet', plan: { id: 'discover-1' } },
  { slug: 'cosmos', plan: { id: 'discover-1' } },
  { slug: 'symbiosis-cooperation-tulsa-fund', plan: { id: 'discover-1' } },
  { slug: 'lamue', plan: { id: 'discover-1' } },
  { slug: 'xwikisas', plan: { id: 'discover-1' } },
  { slug: 'ruma-collective', plan: { id: 'discover-1' } },
  { slug: 'stichting-democracynext', plan: { id: 'discover-1' } },
  { slug: 'break-loose-llc', plan: { id: 'discover-1' } },
  {
    slug: 'midwest-open-source-alliance',
    plan: {
      basePlanId: 'discover-1',
      pricing: { includedCollectives: 3, pricePerMonth: 0 },
      features: {},
    },
  },
  { slug: 'hsvbailfund', plan: { id: 'discover-1' } },
  { slug: 'opencollective', plan: { id: 'discover-1' } },
  { slug: '10tails-inc', plan: { id: 'discover-1' } },
  { slug: 'help-yourself', plan: { id: 'discover-1' } },
  { slug: 'tsip', plan: { id: 'discover-1' } },
  { slug: 'lancaster-and-morecambe-makers', plan: { id: 'discover-1' } },
  { slug: 'riffcc', plan: { id: 'discover-1' } },
  { slug: 'tve', plan: { id: 'discover-1' } },
  { slug: 'ayumpls', plan: { id: 'discover-1' } },
  { slug: 'commonhaus-foundation', plan: { id: 'discover-1' } },
  { slug: 'cooperationnwi', plan: { id: 'discover-1' } },
  { slug: 'grapevinecollective', plan: { id: 'discover-1' } },
  { slug: 'kcs', plan: { id: 'discover-1' } },
  { slug: 'queer-futures-collective', plan: { id: 'discover-1' } },
  { slug: 'queertopia', plan: { id: 'discover-1' } },
  { slug: 'transition-network', plan: { id: 'discover-1' } },
  { slug: 'xmpp', plan: { id: 'discover-1' } },
  { slug: 'zinc', plan: { id: 'discover-1' } },
  { slug: 'library-of-the-commons1', plan: { id: 'discover-1' } },
  { slug: 'stucco-software', plan: { id: 'discover-1' } },
  { slug: 'chicago-punks-with-lunch', plan: { id: 'discover-1' } },
  { slug: 'cosocial', plan: { id: 'discover-1' } },
  { slug: 'officience2', plan: { id: 'discover-1' } },
  { slug: 'wppconnect', plan: { id: 'discover-1' } },
  {
    slug: 'ridgewood-community-garden',
    plan: { basePlanId: 'discover-1', pricing: {}, features: { [PlatformFeature.TRANSFERWISE]: true } },
  },
  { slug: '350australia', plan: { id: 'discover-1' } },
];
// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the expected plan for a given migration entry from `SPECIAL_MIGRATION_LIST`.
 * If entry is null, we consider that there is no custom plan and default to `discover-1`.
 */
export function resolvePlan(entry: MigrationEntry | null): Partial<PlatformSubscriptionPlan> {
  if (!entry) {
    return PlatformSubscriptionTiers.find(t => t.id === DEFAULT_TIER_ID);
  } else if (entry.plan === null) {
    return null;
  }

  // Default plan
  if ('id' in entry.plan) {
    const tierId = entry.plan.id;
    const catalogTier = PlatformSubscriptionTiers.find(t => t.id === tierId);
    if (!catalogTier) {
      throw new Error(`Tier "${tierId}" not found in tier catalog.`);
    }

    return catalogTier;
  }

  // Base plan + customization
  let basePlan;
  if ('basePlanId' in entry.plan) {
    basePlan = PlatformSubscriptionTiers.find(t => t.id === entry.plan['basePlanId']);
    if (!basePlan) {
      throw new Error(`Base plan "${entry.plan.basePlanId}" not found in tier catalog.`);
    }

    return merge({}, basePlan, entry.plan, { id: `custom-${entry.slug}` });
  }

  throw new Error('Invalid plan configuration');
}

function parseCommaSeparatedSlugs(value: string | undefined): Set<string> | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const slugs = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return slugs.length ? new Set(slugs) : undefined;
}

/**
 * Apply --onlySlugs / --excludeSlugs / --limit to the migrate list (order preserved).
 */
export function filterMigrateActions<T extends { host: Collective }>(
  actions: T[],
  filters: { limit?: number; onlySlugs?: Set<string>; excludeSlugs?: Set<string> },
): T[] {
  let list = actions;
  if (filters.excludeSlugs?.size) {
    list = list.filter(a => !filters.excludeSlugs!.has(a.host.slug));
  }
  if (filters.onlySlugs?.size) {
    list = list.filter(a => filters.onlySlugs!.has(a.host.slug));
  }
  if (filters.limit !== undefined) {
    list = list.slice(0, Math.max(0, filters.limit));
  }
  return list;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function main(
  opts: {
    dryRun?: boolean;
    migrationList?: MigrationEntry[];
    startDate?: Date;
    /** When true, run `deactivateMoneyManagement` for inactive hosts. If false, those hosts are only listed/logged. */
    inactiveDisableMoneyManagement?: boolean;
    /** Max number of accounts to migrate this run (full summary is still logged). */
    limit?: number;
    /** If set, only migrate these host slugs (subset of planned migrations). */
    onlySlugs?: Set<string>;
    /** Slugs to skip migrating this run (full summary still logged). */
    excludeSlugs?: Set<string>;
  } = {},
) {
  const dryRun = opts.dryRun ?? process.env.DRY_RUN !== 'false';
  const migrationList = opts.migrationList ?? SPECIAL_MIGRATION_LIST;
  const startDate = opts.startDate ?? MIGRATION_START_DATE;
  const inactiveDisableMoneyManagement = opts.inactiveDisableMoneyManagement ?? false;
  const limit = opts.limit;
  const onlySlugs = opts.onlySlugs;
  const excludeSlugs = opts.excludeSlugs;
  const migrationFilters = { limit, onlySlugs, excludeSlugs };

  logger.info(`=== Pricing migration script ===`);
  logger.info(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE RUN'}`);
  logger.info(`Migration start date: ${startDate.toISOString()}`);
  logger.info(
    `Inactive hosts (disable money management): ${inactiveDisableMoneyManagement ? 'will apply' : 'log only (pass --inactive-disable-money-management to apply)'}`,
  );

  // 1. Load all legacy organisations (Collective.plan IS NOT NULL, excluding first-party hosts)
  const db = getKysely();
  const allLegacyHosts = await db
    .selectFrom('Collectives')
    .leftJoin('PlatformSubscriptions', 'PlatformSubscriptions.CollectiveId', 'Collectives.id')
    .where('Collectives.deletedAt', 'is', null)
    .where('Collectives.type', '=', CollectiveType.ORGANIZATION)
    .where('Collectives.hasMoneyManagement', '=', true)
    .where('PlatformSubscriptions.id', 'is', null)
    .where(sql`("Collectives".data#>>'{isFirstPartyHost}')::boolean`, 'is not', true)
    .selectAll('Collectives')
    .execute()
    .then(kyselyToSequelizeModels(Collective));

  logger.info(`Found ${allLegacyHosts.length} legacy hosts to migrate.`);

  // 2. Key migrationList
  const migrationBySlug = new Map(migrationList.map(e => [e.slug, e]));

  // 3. Build initial migration plan
  type MigrationAction =
    | { kind: 'skip'; host: Collective; reason: string }
    | { kind: 'migrate'; host: Collective; resolvedPlan: Partial<PlatformSubscriptionPlan> }
    | { kind: 'disable-money-management'; host: Collective };

  const actions: MigrationAction[] = [];

  for (const host of allLegacyHosts) {
    const entry = migrationBySlug.get(host.slug);
    if (entry && entry.plan === null) {
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

  // 4. Check transaction activity and demote inactive organisations to 'disable-money-management'
  const transactionCutoffDate = moment().subtract(1, 'year').toDate();
  const legacyHostToMigrate = actions.filter(a => a.kind === 'migrate').map(a => a.host.id);
  const hostsWithNoTransactionsRows = await db
    .selectFrom('Collectives')
    .leftJoin('Transactions', join =>
      join
        .onRef('Transactions.HostCollectiveId', '=', 'Collectives.id')
        .on('Transactions.deletedAt', 'is', null)
        .on('Transactions.createdAt', '>=', transactionCutoffDate),
    )
    .where('Collectives.deletedAt', 'is', null)
    .where('Collectives.id', 'in', legacyHostToMigrate)
    .select('Collectives.id')
    .groupBy('Collectives.id')
    .having(eb => eb.fn.count('Transactions.id'), '=', 0)
    .execute();

  const hostsWithNoTransactions = new Set(hostsWithNoTransactionsRows.map(row => row.id));
  logger.info(`Found ${hostsWithNoTransactions.size} hosts with no transactions in the last 12 months.`);

  const refinedActions: MigrationAction[] = [];
  for (const action of actions) {
    if (action.kind !== 'migrate') {
      refinedActions.push(action);
      continue;
    } else {
      if (migrationBySlug.has(action.host.slug) || !hostsWithNoTransactions.has(action.host.id)) {
        refinedActions.push(action);
      } else {
        refinedActions.push({ kind: 'disable-money-management', host: action.host });
      }
    }
  }

  // 5. Print summary
  const toMigrate = refinedActions.filter(a => a.kind === 'migrate') as Extract<MigrationAction, { kind: 'migrate' }>[];
  const toDisableMM = refinedActions.filter(a => a.kind === 'disable-money-management') as Extract<
    MigrationAction,
    { kind: 'disable-money-management' }
  >[];
  const toSkip = refinedActions.filter(a => a.kind === 'skip') as Extract<MigrationAction, { kind: 'skip' }>[];

  logger.info(`── To migrate (${toMigrate.length}) ──────────────────────────`);
  for (const action of toMigrate) {
    const tierId = action.resolvedPlan.id;
    const isDefault = tierId === DEFAULT_TIER_ID;
    logger.info(
      `  @${action.host.slug.padEnd(40)} legacy: ${String(action.host.plan).padEnd(25)} → ${tierId}${isDefault ? ' (default)' : ''}`,
    );
  }

  logger.info(`── To disable money management (${toDisableMM.length}) ────────`);
  for (const action of toDisableMM) {
    logger.info(`  @${action.host.slug.padEnd(40)} legacy plan: ${String(action.host.plan || 'none')}`);
  }

  logger.info(`── To skip (${toSkip.length}) ────────────────────────────────`);
  for (const action of toSkip) {
    logger.info(`  @${action.host.slug.padEnd(40)} ${action.reason}`);
  }

  const toMigrateThisRun = filterMigrateActions(toMigrate, migrationFilters);
  const hasExecutionFilters =
    (limit !== undefined && limit >= 0) || (onlySlugs?.size ?? 0) > 0 || (excludeSlugs?.size ?? 0) > 0;

  if (hasExecutionFilters) {
    const filterSuffix = `${onlySlugs?.size ? ` --onlySlugs=${[...onlySlugs].join(',')}` : ''}${excludeSlugs?.size ? ` --excludeSlugs=${[...excludeSlugs].join(',')}` : ''}${limit !== undefined ? ` --limit=${limit}` : ''}`;
    logger.info(
      `── Migration execution this run (${toMigrateThisRun.length} of ${toMigrate.length}) ──${filterSuffix}`,
    );
    for (const action of toMigrateThisRun) {
      const tierId = action.resolvedPlan.id;
      logger.info(`  @${action.host.slug.padEnd(40)} → ${tierId}`);
    }
  }

  if (dryRun) {
    logger.info('Dry run complete. Set DRY_RUN=false to apply changes.');
    return { migrated: 0, disabledMoneyManagement: 0, skipped: toSkip.length, errors: 0 };
  }

  // 6. Apply migrations
  let migrated = 0;
  let disabledMoneyManagement = 0;
  let errors = 0;

  for (const action of toMigrateThisRun) {
    try {
      await sequelize.transaction(async transaction => {
        // Create new platform subscription
        await PlatformSubscription.replaceCurrentSubscription(action.host, startDate, action.resolvedPlan, null, {
          isAutomaticMigration: true,
          transaction,
        });

        // Update host to remove plan and set automaticBillingMigration
        const newPlanAllowsHostFees = action.resolvedPlan.features?.[PlatformFeature.CHARGE_HOSTING_FEES] ?? false;
        await action.host.update(
          {
            ...(!newPlanAllowsHostFees ? { hostFeePercent: 0 } : {}),
            plan: null,
            settings: {
              ...action.host.settings,
              automaticBillingMigration: startDate,
            },
          },
          { transaction },
        );

        logger.info(`Migrated @${action.host.slug}`);
        migrated++;
      });
    } catch (err) {
      logger.error(`Failed to migrate @${action.host.slug}: ${err instanceof Error ? err.message : err}`);
      errors++;
    }
  }

  const toDisableMMThisRun = filterMigrateActions(toDisableMM, { onlySlugs, excludeSlugs });

  if (inactiveDisableMoneyManagement) {
    for (const action of toDisableMMThisRun) {
      try {
        await action.host.deactivateMoneyManagement({ silent: true });
        logger.info(`Disabled money management for @${action.host.slug}`);
        disabledMoneyManagement++;
      } catch (err) {
        logger.warn(
          `Failed to disable money management for @${action.host.slug}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  } else if (toDisableMM.length > 0) {
    const mmFilterNote =
      (onlySlugs?.size ?? 0) > 0 || (excludeSlugs?.size ?? 0) > 0
        ? ` (${toDisableMMThisRun.length} inactive host(s) match --onlySlugs/--excludeSlugs for this pass.)`
        : '';
    logger.info(
      `Skipped disabling money management for ${toDisableMM.length} inactive host(s) (pass --inactive-disable-money-management to apply).${mmFilterNote}`,
    );
  }

  logger.info(
    `=== Done. Migrated: ${migrated}, Disabled money management: ${disabledMoneyManagement}, Skipped: ${toSkip.length}, Errors: ${errors} ===`,
  );
  return { migrated, disabledMoneyManagement, skipped: toSkip.length, errors };
}

if (require.main === module) {
  const program = new Command();
  program
    .name('migrate-to-new-pricing')
    .description('Migrate hosts with legacy plans to PlatformSubscription pricing.')
    .option(
      '--inactive-disable-money-management',
      'Deactivate money management for inactive hosts (12mo no tx, not on list)',
    )
    .option(
      '--limit <number>',
      'Migrate at most this many accounts this run (full plan is still logged above)',
      value => {
        const n = parseInt(value, 10);
        if (Number.isNaN(n) || n < 0) {
          throw new Error(`--limit must be a non-negative integer, got "${value}"`);
        }
        return n;
      },
    )
    .option('--onlySlugs <slugs>', 'Comma-separated host slugs to migrate this run (full plan still logged)')
    .option('--excludeSlugs <slugs>', 'Comma-separated host slugs to skip migrating this run');

  program.parse(process.argv);
  const cli = program.opts<{
    limit?: number;
    onlySlugs?: string;
    excludeSlugs?: string;
    inactiveDisableMoneyManagement?: boolean;
  }>();

  main({
    inactiveDisableMoneyManagement: Boolean(cli.inactiveDisableMoneyManagement),
    limit: cli.limit,
    onlySlugs: parseCommaSeparatedSlugs(cli.onlySlugs),
    excludeSlugs: parseCommaSeparatedSlugs(cli.excludeSlugs),
  })
    .then(() => process.exit(0))
    .catch(err => {
      logger.error(err);
      process.exit(1);
    });
}
