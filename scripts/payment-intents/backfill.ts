/**
 * Backfill PaymentIntents and Transactions.PaymentIntentId from historical data.
 *
 * Usage:
 *   # Dry run (default)
 *   npx ts-node scripts/payment-intents/backfill.ts
 *
 *   # Apply all phases
 *   DRY_RUN=false npx ts-node scripts/payment-intents/backfill.ts
 *
 *   # Resume / partial
 *   DRY_RUN=false npx ts-node scripts/payment-intents/backfill.ts --phase ledger --after-id 500000 --limit 10000
 *
 *   # Targeted debug run
 *   npx ts-node scripts/payment-intents/backfill.ts --order-ids 123,456 --no-dry-run
 */

import '../../server/env';

import { Command } from 'commander';

import logger from '../../server/lib/logger';
import { BackfillPhase, resolveHostIdsFromSlugs, runBackfill } from '../../server/lib/payment-intents/backfill';

const parseList = (value: string | undefined, asNumbers = false): (string | number)[] | undefined => {
  if (value === undefined || value === '') {
    return undefined;
  }
  const items = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    return undefined;
  }
  return asNumbers ? items.map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n)) : items;
};

const main = async (): Promise<void> => {
  const program = new Command();
  program
    .option('--limit <n>', 'Max records per phase', parseInt)
    .option('--after-id <n>', 'Resume cursor (id > after-id)', parseInt)
    .option('--phase <name>', 'ledger | pending-orders | pending-expenses | all', 'all')
    .option('--order-ids <ids>', 'Comma-separated order IDs')
    .option('--expense-ids <ids>', 'Comma-separated expense IDs')
    .option('--host-slugs <slugs>', 'Comma-separated host slugs to restrict scope')
    .parse();

  const options = program.opts();
  const dryRun = process.env.DRY_RUN !== 'false';
  const phase = options.phase as BackfillPhase;

  if (!['ledger', 'pending-orders', 'pending-expenses', 'all'].includes(phase)) {
    logger.error(`Invalid phase: ${phase}`);
    process.exit(1);
  }

  const hostSlugs = parseList(options.hostSlugs) as string[] | undefined;
  let hostIds: number[] | undefined;
  if (hostSlugs?.length) {
    hostIds = await resolveHostIdsFromSlugs(hostSlugs);
    if (hostIds.length === 0) {
      logger.error(`No hosts found for slugs: ${hostSlugs.join(', ')}`);
      process.exit(1);
    }
    logger.info(`Restricting to hosts: ${hostSlugs.join(', ')} (ids: ${hostIds.join(', ')})`);
  }

  if (dryRun) {
    logger.info('Running in DRY RUN mode');
  }

  const results = await runBackfill(phase, {
    dryRun,
    limit: options.limit,
    afterId: options.afterId,
    orderIds: parseList(options.orderIds, true) as number[] | undefined,
    expenseIds: parseList(options.expenseIds, true) as number[] | undefined,
    hostIds,
  });

  const totalErrors = Object.values(results).reduce((sum, stats) => sum + stats.errors, 0);
  if (totalErrors > 0) {
    process.exit(1);
  }
};

if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch(error => {
      logger.error(error);
      process.exit(1);
    });
}
