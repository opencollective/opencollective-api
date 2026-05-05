/**
 * Analyzes which platform subscription catalog tiers best match usage for hosts with an active
 * PlatformSubscription, for a chosen calendar month (default: previous month, UTC).
 *
 * Usage:
 *   npx ts-node scripts/billing/analyze-platform-plan-fit.ts
 *   npx ts-node scripts/billing/analyze-platform-plan-fit.ts --month 2026-03
 */

import '../../server/env';

import { Command } from 'commander';
import { merge } from 'lodash';
import moment from 'moment';
import { Op } from 'sequelize';

import { CollectiveType } from '../../server/constants/collectives';
import { PlatformSubscriptionPlan, PlatformSubscriptionTiers } from '../../server/constants/plans';
import logger from '../../server/lib/logger';
import { Collective, PlatformSubscription, sequelize } from '../../server/models';
import {
  BillingMonth,
  BillingPeriod,
  estimateMonthlyPriceForPlan,
  getCostOptimalPlatformTiersForUtilization,
  getPlanChangeType,
  PeriodUtilization,
  PlatformPlanSuggestion,
} from '../../server/models/PlatformSubscription';

export function parseMonthOption(value: string): BillingPeriod {
  const m = moment.utc(value, 'YYYY-MM', true);
  if (!m.isValid()) {
    throw new Error(`Invalid --month "${value}". Use YYYY-MM (e.g. 2026-03).`);
  }
  return { year: m.year(), month: m.month() as BillingMonth };
}

function defaultPreviousMonth(): BillingPeriod {
  const ref = moment.utc().subtract(1, 'month');
  return { year: ref.year(), month: ref.month() as BillingMonth };
}

function resolveStoredPlan(plan: Partial<PlatformSubscriptionPlan>): PlatformSubscriptionPlan | null {
  const key = plan.basePlanId ?? plan.id;
  if (!key) {
    return null;
  }
  const catalog = PlatformSubscriptionTiers.find(t => t.id === key);
  if (!catalog) {
    return null;
  }
  return merge({}, catalog, plan, { basePlanId: catalog.id }) as PlatformSubscriptionPlan;
}

function pickPrimarySuggestion(suggestions: PlatformPlanSuggestion[]): PlatformPlanSuggestion {
  return suggestions.reduce((best, cur) => {
    const ib = PlatformSubscriptionTiers.findIndex(t => t.id === best.plan.id);
    const ic = PlatformSubscriptionTiers.findIndex(t => t.id === cur.plan.id);
    if (ib === -1) {
      return cur;
    }
    if (ic === -1) {
      return best;
    }
    return ic < ib ? cur : best;
  });
}

export type PlanFitBucket = 'ok' | 'downgrade' | 'upgrade' | 'review';

export function classifyRow(args: {
  suggestions: PlatformPlanSuggestion[];
  currentPlan: Partial<PlatformSubscriptionPlan>;
  utilization: PeriodUtilization;
}): { bucket: PlanFitBucket; reason?: string } {
  const { suggestions, currentPlan, utilization } = args;
  if (suggestions.length === 0) {
    return { bucket: 'review', reason: 'no_suggestions' };
  }

  const suggestionIds = new Set(suggestions.map(s => s.plan.id));
  const currentKey = currentPlan.basePlanId ?? currentPlan.id;
  const minPrice = suggestions[0].estimatedPricePerMonth;
  const merged = resolveStoredPlan(currentPlan);

  let isRight = false;
  if (currentKey !== undefined && suggestionIds.has(String(currentKey))) {
    isRight = true;
  } else if (merged) {
    const currentEst = estimateMonthlyPriceForPlan(merged, utilization);
    isRight = currentEst === minPrice;
  }

  const primary = pickPrimarySuggestion(suggestions);
  const currentForCompare = merged ?? currentPlan;
  const change = getPlanChangeType(currentForCompare, primary.plan);

  const types = new Set(suggestions.map(s => s.plan.type));
  const ambiguousTiers = types.size > 1;

  if (isRight) {
    return ambiguousTiers ? { bucket: 'ok', reason: 'optimal_cost_tier_tie' } : { bucket: 'ok' };
  }

  if (change === 'CUSTOM') {
    return { bucket: 'review', reason: 'custom_or_unknown_tier' };
  }

  if (ambiguousTiers) {
    return { bucket: 'review', reason: 'multiple_tier_types_at_min_price' };
  }

  if (change === 'DOWNGRADE') {
    return { bucket: 'downgrade' };
  }
  if (change === 'UPGRADE') {
    return { bucket: 'upgrade' };
  }

  return { bucket: 'review', reason: 'no_change_but_not_optimal' };
}

export async function loadHostsWithActivePlatformSubscription(): Promise<Collective[]> {
  const subs = await PlatformSubscription.findAll({
    where: {
      deletedAt: null,
      period: { [Op.contains]: new Date() },
    },
    include: [
      {
        model: Collective,
        as: 'collective',
        required: true,
        where: {
          [Op.and]: [
            { type: CollectiveType.ORGANIZATION, hasMoneyManagement: true, deletedAt: null },
            sequelize.literal(`(data->>'isFirstPartyHost')::boolean IS NOT TRUE`),
          ],
        },
      },
    ],
  });

  return subs.map(s => s.collective).filter((c): c is Collective => Boolean(c));
}

export async function main(): Promise<void> {
  const program = new Command();
  program.option('--month <YYYY-MM>', 'Calendar month in UTC (default: previous month)').parse(process.argv);

  const opts = program.opts<{ month?: string }>();
  const billingPeriod = opts.month ? parseMonthOption(opts.month) : defaultPreviousMonth();

  const monthLabel = `${billingPeriod.year}-${String(billingPeriod.month + 1).padStart(2, '0')}`;
  logger.info(`=== Platform plan fit analysis (${monthLabel} UTC) ===`);

  const hosts = await loadHostsWithActivePlatformSubscription();
  logger.info(`Hosts with active platform subscription (non–first-party orgs, money management): ${hosts.length}`);

  if (hosts.length === 0) {
    return;
  }

  const ids = hosts.map(h => h.id);
  const utilizationById = await PlatformSubscription.calculateUtilizationForCollectives(ids, billingPeriod);
  logger.info(`Utilization calculated for ${ids.length} hosts`);
  const suggestionsById = await PlatformSubscription.suggestPlans(ids, billingPeriod);
  logger.info(`Suggestions calculated for ${ids.length} hosts`);

  const sections: Record<PlanFitBucket, Collective[]> = {
    ok: [],
    downgrade: [],
    upgrade: [],
    review: [],
  };

  const rows: Array<{
    bucket: PlanFitBucket;
    slug: string;
    id: number;
    utilization: PeriodUtilization;
    currentKey: string | number;
    suggestions: PlatformPlanSuggestion[];
    reason?: string;
  }> = [];

  for (const host of hosts) {
    const sub = await PlatformSubscription.getCurrentSubscription(host.id);
    if (!sub) {
      rows.push({
        bucket: 'review',
        slug: host.slug,
        id: host.id,
        utilization: utilizationById.get(host.id) ?? { activeCollectives: 0, expensesPaid: 0 },
        currentKey: 'none',
        suggestions: suggestionsById.get(host.id) ?? [],
        reason: 'no_current_subscription',
      });
      sections.review.push(host);
      continue;
    }

    const utilization = utilizationById.get(host.id) ?? { activeCollectives: 0, expensesPaid: 0 };
    const suggestions = suggestionsById.get(host.id) ?? getCostOptimalPlatformTiersForUtilization(utilization);
    const currentKey = sub.plan.basePlanId ?? sub.plan.id ?? 'unknown';
    const { bucket, reason } = classifyRow({
      suggestions,
      currentPlan: sub.plan,
      utilization,
    });

    rows.push({
      bucket,
      slug: host.slug,
      id: host.id,
      utilization,
      currentKey,
      suggestions,
      reason,
    });
    sections[bucket].push(host);
  }

  const printSection = (title: string, bucket: PlanFitBucket) => {
    const list = rows.filter(r => r.bucket === bucket);
    logger.info('');
    logger.info(`── ${title} (${list.length}) ──`);
    for (const r of list) {
      const sug = r.suggestions
        .map(s => `${s.plan.id} ($${(s.estimatedPricePerMonth / 100).toFixed(2)}/mo)`)
        .join(', ');
      const util = `collectives=${r.utilization.activeCollectives}, expenses=${r.utilization.expensesPaid}`;
      const extra = r.reason ? ` [${r.reason}]` : '';
      logger.info(`  @${r.slug} id=${r.id} ${util} current=${r.currentKey} → ${sug}${extra}`);
    }
  };

  printSection('Right plan (optimal or matching tier)', 'ok');
  printSection('Should ideally be downgraded', 'downgrade');
  printSection('Should ideally be upgraded', 'upgrade');
  printSection('Review (custom tier, ties, or ambiguous)', 'review');

  logger.info('');
  logger.info(
    `Summary: ok=${sections.ok.length} downgrade=${sections.downgrade.length} upgrade=${sections.upgrade.length} review=${sections.review.length}`,
  );
}

if (module === require.main) {
  main().catch(e => {
    logger.error(e);
    process.exit(1);
  });
}
