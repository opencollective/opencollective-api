/**
 * Refetches PayPal payout item details for past `collective.expense.error` activities that were
 * stored without an `error`: at batch review PayPal sometimes omits `errors` from failed items,
 * while `GET /v1/payments/payouts-item/{payout_item_id}` returns them.
 *
 * Only activities whose data has no `error` yet are considered. Rows are updated in place (no new
 * thread entries) and the raw provider payload is stored, so debugging data stays available;
 * `sanitizeErrorData` still decides what is exposed to clients.
 *
 * Usage:
 *   npm run script scripts/paypal/refetch-expense-error-details.ts -- --dry-run
 *   npm run script scripts/paypal/refetch-expense-error-details.ts -- --since 2026-01-01
 *   npm run script scripts/paypal/refetch-expense-error-details.ts -- --since 2026-01-01 --host-id 123
 */

import '../../server/env';

import { Command } from 'commander';
import { omit } from 'lodash';
import moment from 'moment';
import { QueryTypes } from 'sequelize';

import activities from '../../server/constants/activities';
import { Service } from '../../server/constants/connected-account';
import logger from '../../server/lib/logger';
import * as paypal from '../../server/lib/paypal';
import { sleep } from '../../server/lib/utils';
import models, { ConnectedAccount, sequelize } from '../../server/models';

type ActivityRow = {
  id: number;
  HostCollectiveId: number | null;
  ExpenseId: number | null;
  data: {
    payoutItem: { payout_item_id: string; transaction_status?: string };
    [key: string]: unknown;
  };
};

type RefetchExpenseErrorDetailsOptions = {
  /** Only consider activities created on or after this date */
  since?: Date;
  /** Only consider activities for this host (Collective id) */
  hostId?: number;
  /** Fetch and log, but do not write anything */
  dryRun?: boolean;
};

type RefetchExpenseErrorDetailsStats = {
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
};

const getStatusDerivedError = (transactionStatus: string): { message: string } => ({
  message: `PayPal payout item ${transactionStatus}`,
});

/** A short, non-sensitive description of what is stored; provider payloads must not be logged. */
const describeStoredError = (error: { name?: string; message?: string }): string =>
  error.name ?? error.message ?? 'unknown error';

/**
 * PayPal HTTP failures carry the raw response body in `error.message`, so only allowlisted fields
 * (HTTP status, error name) may be logged.
 */
const describeRequestFailure = (error: unknown): string => {
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  if (typeof statusCode === 'number') {
    return `PayPal request failed with HTTP ${statusCode}`;
  }
  return error instanceof Error ? error.name : 'unknown error';
};

export function parseHostIdOption(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const hostId = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(hostId) || hostId <= 0) {
    throw new Error(`Invalid --host-id: ${value}`);
  }

  return hostId;
}

export async function refetchExpenseErrorDetails({
  since,
  hostId,
  dryRun = false,
}: RefetchExpenseErrorDetailsOptions = {}): Promise<RefetchExpenseErrorDetailsStats> {
  const rows = await sequelize.query<ActivityRow>(
    `
    SELECT a."id", a."HostCollectiveId", a."ExpenseId", a."data"
    FROM "Activities" a
    WHERE a."type" = :type
      AND a."data" -> 'payoutItem' ->> 'payout_item_id' IS NOT NULL
      AND (a."data" -> 'error' IS NULL OR a."data" ->> 'errorRetrievalFailed' = 'true')
      ${hostId ? 'AND a."HostCollectiveId" = :hostId' : ''}
      ${since ? 'AND a."createdAt" >= :since' : ''}
    ORDER BY a."createdAt" ASC
    `,
    {
      replacements: { type: activities.COLLECTIVE_EXPENSE_ERROR, hostId, since },
      type: QueryTypes.SELECT,
      raw: true,
    },
  );

  const stats: RefetchExpenseErrorDetailsStats = { scanned: rows.length, updated: 0, skipped: 0, failed: 0 };
  const connectedAccountsByHost = new Map<number, ConnectedAccount>();

  for (const row of rows) {
    try {
      const host = row.HostCollectiveId ? await models.Collective.findByPk(row.HostCollectiveId) : null;
      if (!host) {
        stats.skipped++;
        logger.warn(`refetch-expense-error-details: activity #${row.id} has no host, skipping`);
        continue;
      }

      if (!connectedAccountsByHost.has(host.id)) {
        const connectedAccount = await host.getAccountForPaymentProvider(Service.PAYPAL, { throwIfMissing: false });
        connectedAccountsByHost.set(host.id, connectedAccount);
      }
      const connectedAccount = connectedAccountsByHost.get(host.id);
      if (!connectedAccount) {
        stats.skipped++;
        logger.warn(
          `refetch-expense-error-details: host @${host.slug} (#${host.id}) has no PayPal connected account, skipping activity #${row.id}`,
        );
        continue;
      }

      const payoutItem = await paypal.getPayoutItem(connectedAccount, row.data.payoutItem.payout_item_id);
      const error =
        payoutItem?.errors ??
        getStatusDerivedError(payoutItem?.transaction_status ?? row.data.payoutItem.transaction_status);

      if (dryRun) {
        logger.info(
          `[dry-run] refetch-expense-error-details: activity #${row.id} (expense #${row.ExpenseId}) would store ${describeStoredError(error)}`,
        );
      } else {
        const activity = await models.Activity.findByPk(row.id);
        if (!activity) {
          stats.skipped++;
          logger.warn(`refetch-expense-error-details: activity #${row.id} disappeared, skipping`);
          continue;
        }

        // Recheck eligibility on the row we are about to write: another writer may have filled the error
        if (activity.data?.error && !activity.data?.errorRetrievalFailed) {
          stats.skipped++;
          logger.warn(`refetch-expense-error-details: activity #${row.id} got an error in the meantime, skipping`);
          continue;
        }

        await activity.update({ data: { ...omit(activity.data, 'errorRetrievalFailed'), error, payoutItem } });
        stats.updated++;
        logger.info(
          `refetch-expense-error-details: activity #${row.id} (expense #${row.ExpenseId}) updated with ${describeStoredError(error)}`,
        );
      }
    } catch (e) {
      stats.failed++;
      logger.warn(`refetch-expense-error-details: activity #${row.id}: ${describeRequestFailure(e)}`);
    }

    await sleep(500);
  }

  logger.info(
    `refetch-expense-error-details: scanned=${stats.scanned} updated=${stats.updated} skipped=${stats.skipped} failed=${stats.failed}${dryRun ? ' (dry run)' : ''}`,
  );
  return stats;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('refetch-expense-error-details')
    .allowExcessArguments(true)
    .description(
      'Refetch PayPal payout item error details for collective.expense.error activities stored without an error',
    )
    .option('--since <date>', 'Only consider activities created on or after this date (ISO 8601, e.g. 2026-01-31)')
    .option('--host-id <id>', 'Only consider activities for this host (Collective id)')
    .option('--dry-run', 'Fetch and log the details without writing anything')
    .parse();

  const opts = program.opts<{ since?: string; hostId?: string; dryRun?: boolean }>();

  const since = opts.since ? moment(opts.since, moment.ISO_8601, true) : undefined;
  if (since && !since.isValid()) {
    throw new Error(`Invalid --since date: ${opts.since}`);
  }

  const hostId = parseHostIdOption(opts.hostId);

  try {
    const stats = await refetchExpenseErrorDetails({ since: since?.toDate(), hostId, dryRun: opts.dryRun });
    if (stats.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main().catch(e => {
    logger.error(e);
    process.exit(1);
  });
}
