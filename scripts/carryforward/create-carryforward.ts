/**
 * Script to create balance carryforward transactions.
 *
 * Usage:
 *   npm run script scripts/carryforward/create-carryforward.ts <year> [options]
 *
 * Examples:
 *   # Single collective
 *   npm run script scripts/carryforward/create-carryforward.ts 2019 --collective my-collective
 *   npm run script scripts/carryforward/create-carryforward.ts 2019 --collective 12345 --dry-run
 *
 *   # All collectives (batch mode)
 *   npm run script scripts/carryforward/create-carryforward.ts 2019 --dry-run
 *   npm run script scripts/carryforward/create-carryforward.ts 2019 --host 123 --limit 100
 */

import '../../server/env';

import { Command } from 'commander';
import moment from 'moment';

import { getBalances } from '../../server/lib/budget';
import {
  CarryforwardStatus,
  computeCarryforwardBalance,
  createBalanceCarryforward,
  getBalancesByHostAndCurrency,
} from '../../server/lib/ledger/carryforward';
import models, { Op, sequelize } from '../../server/models';

interface ProcessingResult {
  collectiveId: number;
  slug: string;
  status: CarryforwardStatus | 'ERROR';
  error?: string;
  balance?: number;
  hostCurrency?: string;
}

const program = new Command()
  .name('create-carryforward')
  .description('Create balance carryforward transactions')
  .argument('<year>', 'The year to close (e.g., 2019 creates carryforward at Dec 31, 2019)', value => {
    const year = parseInt(value, 10);
    if (isNaN(year) || year < 2015 || year > new Date().getFullYear()) {
      throw new Error(`Invalid year: ${value}. Must be between 2015 and current year.`);
    }
    return year;
  })
  .option('--collective <id|slug>', 'Process a single collective by ID or slug')
  .option('--dry-run', 'Show what would be done without creating transactions', false)
  .option('--host <id>', 'Only process collectives under this host (batch mode)', value => parseInt(value, 10))
  .option('--limit <n>', 'Process max N collectives (batch mode)', value => parseInt(value, 10))
  .option('--offset <n>', 'Skip first N collectives (batch mode)', value => parseInt(value, 10), 0)
  .option('--verbose', 'Show detailed output for each collective', false);

async function findCollectivesToProcess(year: number, host: number | null): Promise<number[]> {
  const cutoffDate = moment.utc(`${year + 1}-01-01`).toDate();

  const whereClause: Record<string, unknown> = {
    createdAt: { [Op.lt]: cutoffDate },
    HostCollectiveId: { [Op.not]: null },
  };

  if (host) {
    whereClause.HostCollectiveId = host;
  }

  const results = (await models.Transaction.findAll({
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('CollectiveId')), 'CollectiveId']],
    where: whereClause,
    order: [[sequelize.col('CollectiveId'), 'ASC']],
    raw: true,
  })) as unknown as { CollectiveId: number }[];

  return results.map(r => r.CollectiveId);
}

async function findCollectiveByIdOrSlug(identifier: string): Promise<number | null> {
  const collectiveId = parseInt(identifier, 10);
  if (!isNaN(collectiveId)) {
    const collective = await models.Collective.findByPk(collectiveId, { attributes: ['id'] });
    return collective?.id || null;
  } else {
    const collective = await models.Collective.findOne({
      where: { slug: identifier.toLowerCase() },
      attributes: ['id'],
    });
    return collective?.id || null;
  }
}

async function processCollective(
  collectiveId: number,
  carryforwardDate: Date,
  dryRun: boolean,
): Promise<ProcessingResult> {
  const collective = await models.Collective.findByPk(collectiveId, {
    attributes: ['id', 'slug', 'name', 'settings', 'currency'],
  });

  if (!collective) {
    return {
      collectiveId,
      slug: 'UNKNOWN',
      status: 'ERROR',
      error: 'Collective not found',
    };
  }

  if (dryRun) {
    const computed = await computeCarryforwardBalance(collectiveId, carryforwardDate);

    let hostCurrencyStr: string | undefined = computed.currency;
    if (computed.conversionDetails) {
      hostCurrencyStr = `${computed.currency} (converted: ${computed.conversionDetails})`;
    }

    return {
      collectiveId,
      slug: collective.slug,
      status: computed.status,
      balance: computed.balance,
      hostCurrency: hostCurrencyStr,
      error: computed.error,
    };
  }

  try {
    const result = await createBalanceCarryforward(collective, carryforwardDate);

    return {
      collectiveId,
      slug: collective.slug,
      status: result.status,
      balance: result.balance,
      hostCurrency: result.closingTransaction?.hostCurrency,
      error: result.error,
    };
  } catch (error) {
    return {
      collectiveId,
      slug: collective.slug,
      status: 'ERROR',
      error: error.message,
    };
  }
}

async function processSingleCollective(collectiveId: number, carryforwardDate: Date, dryRun: boolean): Promise<void> {
  const collective = await models.Collective.findByPk(collectiveId);

  if (!collective) {
    console.error(`Collective not found: ${collectiveId}`);
    process.exit(1);
  }

  console.log(`Collective: ${collective.name} (slug: ${collective.slug}, id: ${collective.id})`);
  console.log(`Carryforward date: ${moment(carryforwardDate).format('YYYY-MM-DD')}`);
  console.log(`Dry run: ${dryRun}`);
  console.log('');

  // Get balance before carryforward
  const balanceBeforeResult = await getBalances([collective.id], { useMaterializedView: false });
  const balanceBefore = balanceBeforeResult[collective.id]?.value || 0;
  const currencyBefore = balanceBeforeResult[collective.id]?.currency || 'USD';

  console.log(`Current balance: ${(balanceBefore / 100).toFixed(2)} ${currencyBefore}`);

  // Get balances by host and currency
  const balancesByHost = await getBalancesByHostAndCurrency(collective.id, { endDate: carryforwardDate });
  console.log(`\nBalances by host/currency:`);
  if (balancesByHost.length === 0) {
    console.log('  No balances found');
  } else {
    for (const b of balancesByHost) {
      console.log(`  Host ${b.HostCollectiveId}: ${(b.balance / 100).toFixed(2)} ${b.hostCurrency}`);
    }
  }

  if (dryRun) {
    const computed = await computeCarryforwardBalance(collectiveId, carryforwardDate);

    console.log(`\nDry run result:`);
    console.log(`  Status: ${computed.status}`);
    if (computed.balance !== undefined) {
      console.log(`  Balance: ${(computed.balance / 100).toFixed(2)} ${computed.currency}`);
    }
    if (computed.conversionDetails) {
      console.log(`  Conversions: ${computed.conversionDetails}`);
    }
    if (computed.error) {
      console.log(`  Error: ${computed.error}`);
    }

    console.log('\n(DRY RUN - no transactions created)');
    return;
  }

  console.log('\nCreating balance carryforward...');

  try {
    const result = await createBalanceCarryforward(collective, carryforwardDate);

    switch (result.status) {
      case 'SKIPPED_ZERO_BALANCE':
        console.log('\nNo carryforward created - balance is zero.');
        break;

      case 'SKIPPED_ALREADY_EXISTS':
        console.log('\nNo carryforward created - carryforward already exists at this date.');
        break;

      case 'SKIPPED_NO_HOST_TRANSACTIONS':
        console.log('\nNo carryforward created - no transactions with a host before the carryforward date.');
        break;

      case 'ERROR_MULTI_CURRENCY':
        console.error(`\nError: ${result.error}`);
        console.error('This requires manual review.');
        process.exit(1);
        break;

      case 'CREATED': {
        console.log('\nCarryforward created successfully!');
        console.log(`  Closing transaction ID: ${result.closingTransaction.id}`);
        console.log(`  Opening transaction ID: ${result.openingTransaction.id}`);
        console.log(`  Balance: ${(result.balance / 100).toFixed(2)} ${result.closingTransaction.hostCurrency}`);
        console.log(`  Transaction group: ${result.closingTransaction.TransactionGroup}`);

        // Verify balance after carryforward
        const balanceAfterResult = await getBalances([collective.id], { useMaterializedView: false });
        const balanceAfter = balanceAfterResult[collective.id]?.value || 0;
        const currencyAfter = balanceAfterResult[collective.id]?.currency || 'USD';

        console.log(`\nVerification:`);
        console.log(`  Balance before: ${(balanceBefore / 100).toFixed(2)} ${currencyBefore}`);
        console.log(`  Balance after:  ${(balanceAfter / 100).toFixed(2)} ${currencyAfter}`);

        if (balanceBefore === balanceAfter) {
          console.log('\nBalance unchanged after carryforward.');
        } else {
          console.error(
            `\nWARNING: Balance changed! Difference: ${((balanceAfter - balanceBefore) / 100).toFixed(2)} ${currencyAfter}`,
          );
          process.exit(1);
        }
        break;
      }
    }
  } catch (error) {
    console.error(`\nError creating carryforward: ${error.message}`);
    process.exit(1);
  }
}

async function processBatch(
  year: number,
  carryforwardDate: Date,
  options: { dryRun: boolean; host?: number; limit?: number; offset: number; verbose: boolean },
): Promise<void> {
  console.log('='.repeat(70));
  console.log(`Balance Carryforward - Year ${year}`);
  console.log('='.repeat(70));
  console.log(`Carryforward date: ${year}-12-31`);
  console.log(`Dry run: ${options.dryRun}`);
  if (options.host) {
    console.log(`Host filter: ${options.host}`);
  }
  if (options.limit) {
    console.log(`Limit: ${options.limit}`);
  }
  if (options.offset) {
    console.log(`Offset: ${options.offset}`);
  }
  console.log('');

  console.log('Finding collectives with transactions before cutoff date...');
  let collectiveIds = await findCollectivesToProcess(year, options.host || null);

  if (options.offset > 0) {
    collectiveIds = collectiveIds.slice(options.offset);
  }
  if (options.limit) {
    collectiveIds = collectiveIds.slice(0, options.limit);
  }

  console.log(`Found ${collectiveIds.length} collectives to process`);
  console.log('');

  if (collectiveIds.length === 0) {
    console.log('No collectives to process.');
    process.exit(0);
  }

  const results: ProcessingResult[] = [];
  const statusCounts: Record<string, number> = {
    CREATED: 0,
    SKIPPED_ZERO_BALANCE: 0,
    SKIPPED_ALREADY_EXISTS: 0,
    SKIPPED_NO_HOST_TRANSACTIONS: 0,
    ERROR_MULTI_CURRENCY: 0,
    ERROR: 0,
  };

  const created: ProcessingResult[] = [];
  const errors: ProcessingResult[] = [];
  const multiCurrencyErrors: ProcessingResult[] = [];

  console.log(`Processing ${collectiveIds.length} collectives...`);
  console.log('');

  for (let i = 0; i < collectiveIds.length; i++) {
    const collectiveId = collectiveIds[i];
    const result = await processCollective(collectiveId, carryforwardDate, options.dryRun);

    results.push(result);
    statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;

    if (result.status === 'CREATED') {
      created.push(result);
    } else if (result.status === 'ERROR') {
      errors.push(result);
    } else if (result.status === 'ERROR_MULTI_CURRENCY') {
      multiCurrencyErrors.push(result);
    }

    if (
      options.verbose ||
      result.status === 'CREATED' ||
      result.status === 'ERROR' ||
      result.status === 'ERROR_MULTI_CURRENCY'
    ) {
      const statusEmoji =
        result.status === 'CREATED'
          ? '✓'
          : result.status.startsWith('SKIPPED')
            ? '○'
            : result.status.startsWith('ERROR')
              ? '✗'
              : '?';
      const amountStr = result.balance ? ` ${(result.balance / 100).toFixed(2)} ${result.hostCurrency}` : '';
      console.log(
        `[${i + 1}/${collectiveIds.length}] ${statusEmoji} ${result.slug} (${result.collectiveId}): ${result.status}${amountStr}${result.error ? ` - ${result.error}` : ''}`,
      );
    } else if ((i + 1) % 100 === 0) {
      console.log(`[${i + 1}/${collectiveIds.length}] Processing...`);
    }
  }

  // Print summary
  console.log('');
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`Total processed: ${results.length}`);
  console.log('');
  console.log('Results by status:');
  console.log(`  CREATED:                   ${statusCounts.CREATED}`);
  console.log(`  SKIPPED_ZERO_BALANCE:      ${statusCounts.SKIPPED_ZERO_BALANCE}`);
  console.log(`  SKIPPED_ALREADY_EXISTS:    ${statusCounts.SKIPPED_ALREADY_EXISTS}`);
  console.log(`  SKIPPED_NO_HOST_TRANSACTIONS: ${statusCounts.SKIPPED_NO_HOST_TRANSACTIONS}`);
  console.log(`  ERROR_MULTI_CURRENCY:      ${statusCounts.ERROR_MULTI_CURRENCY}`);
  console.log(`  ERROR:                     ${statusCounts.ERROR}`);

  if (created.length > 0) {
    console.log('');
    console.log('Created carryforwards:');
    for (const c of created) {
      const amount = c.balance ? `${(c.balance / 100).toFixed(2)} ${c.hostCurrency}` : 'N/A';
      console.log(`  - ${c.slug} (${c.collectiveId}): ${amount}`);
    }
  }

  if (multiCurrencyErrors.length > 0) {
    console.log('');
    console.log('Collectives requiring manual review (multi-currency):');
    for (const e of multiCurrencyErrors) {
      console.log(`  - ${e.slug} (${e.collectiveId}): ${e.error}`);
    }
  }

  if (errors.length > 0) {
    console.log('');
    console.log('Errors:');
    for (const e of errors) {
      console.log(`  - ${e.slug} (${e.collectiveId}): ${e.error}`);
    }
  }

  if (options.dryRun) {
    console.log('');
    console.log('(DRY RUN - no transactions were created)');
  }

  const hasFailures = statusCounts.ERROR > 0 || statusCounts.ERROR_MULTI_CURRENCY > 0;
  process.exit(hasFailures ? 1 : 0);
}

async function main() {
  program.parse();
  const year = parseInt(program.args[0], 10);
  const options = program.opts<{
    collective?: string;
    dryRun: boolean;
    host?: number;
    limit?: number;
    offset: number;
    verbose: boolean;
  }>();

  const carryforwardDate = moment.utc(`${year}-12-31`).endOf('day').toDate();

  if (options.collective) {
    // Single collective mode
    const collectiveId = await findCollectiveByIdOrSlug(options.collective);
    if (!collectiveId) {
      console.error(`Collective not found: ${options.collective}`);
      process.exit(1);
    }
    await processSingleCollective(collectiveId, carryforwardDate, options.dryRun);
  } else {
    // Batch mode
    await processBatch(year, carryforwardDate, options);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
