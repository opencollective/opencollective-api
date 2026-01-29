/**
 * Verification script to check 100% carryforward coverage for a given year.
 *
 * Usage:
 *   npm run script scripts/carryforward/verify-carryforward.ts <year> [options]
 *
 * Example:
 *   npm run script scripts/carryforward/verify-carryforward.ts 2017
 *   npm run script scripts/carryforward/verify-carryforward.ts 2017 --host 123 --verbose
 */

import '../../server/env';

import { Command } from 'commander';
import moment from 'moment';

import { TransactionKind } from '../../server/constants/transaction-kind';
import { TransactionTypes } from '../../server/constants/transactions';
import { getBalancesByHostAndCurrency } from '../../server/lib/ledger/carryforward';
import models, { Op, sequelize } from '../../server/models';

type VerificationStatus =
  | 'OK_CARRYFORWARD'
  | 'OK_ZERO_BALANCE'
  | 'OK_NO_HOST_TRANSACTIONS'
  | 'MISSING'
  | 'ERROR_MULTI_CURRENCY';

interface VerificationResult {
  collectiveId: number;
  slug: string;
  status: VerificationStatus;
  balance?: number;
  hostCurrency?: string;
  details?: string;
}

const program = new Command()
  .name('verify-carryforward')
  .description('Check 100% carryforward coverage for a given year')
  .argument('<year>', 'The year to verify (e.g., 2017 checks carryforward at Jan 1, 2018)', value => {
    const year = parseInt(value, 10);
    if (isNaN(year) || year < 2015 || year > new Date().getFullYear()) {
      throw new Error(`Invalid year: ${value}. Must be between 2015 and current year.`);
    }
    return year;
  })
  .option('--host <id>', 'Only check collectives under this host', value => parseInt(value, 10))
  .option('--verbose', 'Show all collectives, not just problems', false);

async function findCollectivesWithTransactions(year: number, host: number | null): Promise<number[]> {
  const cutoffDate = moment.utc(`${year + 1}-01-01`).toDate();

  // Find all distinct CollectiveIds that have transactions with a HostCollectiveId before the cutoff date
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

async function hasCarryforwardAtDate(collectiveId: number, openingDate: Date): Promise<boolean> {
  const existing = await models.Transaction.findOne({
    where: {
      CollectiveId: collectiveId,
      kind: TransactionKind.BALANCE_CARRYFORWARD,
      type: TransactionTypes.CREDIT,
      createdAt: openingDate,
    },
  });
  return !!existing;
}

async function hasHostTransactionsBeforeCutoff(collectiveId: number, cutoffDate: Date): Promise<boolean> {
  const transaction = await models.Transaction.findOne({
    where: {
      CollectiveId: collectiveId,
      HostCollectiveId: { [Op.not]: null },
      createdAt: { [Op.lt]: cutoffDate },
    },
  });
  return !!transaction;
}

async function verifyCollective(
  collectiveId: number,
  cutoffDate: Date,
  openingDate: Date,
): Promise<VerificationResult> {
  const collective = await models.Collective.findByPk(collectiveId, {
    attributes: ['id', 'slug', 'name'],
  });

  if (!collective) {
    return {
      collectiveId,
      slug: 'UNKNOWN',
      status: 'MISSING',
      details: 'Collective not found',
    };
  }

  // Check if carryforward exists at the opening date
  const hasCarryforward = await hasCarryforwardAtDate(collectiveId, openingDate);
  if (hasCarryforward) {
    return {
      collectiveId,
      slug: collective.slug,
      status: 'OK_CARRYFORWARD',
    };
  }

  // Check if there are any transactions with a host before cutoff
  const hasHostTxns = await hasHostTransactionsBeforeCutoff(collectiveId, cutoffDate);
  if (!hasHostTxns) {
    return {
      collectiveId,
      slug: collective.slug,
      status: 'OK_NO_HOST_TRANSACTIONS',
    };
  }

  // Get balance at end of year (cutoff - 1 day at end of day)
  const endOfYearDate = moment.utc(cutoffDate).subtract(1, 'day').endOf('day').toDate();
  const balancesByHost = await getBalancesByHostAndCurrency(collectiveId, { endDate: endOfYearDate });

  // Filter to only non-zero balances
  const nonZeroBalances = balancesByHost.filter(b => b.balance !== 0);

  // If balance is zero, no carryforward needed
  if (nonZeroBalances.length === 0) {
    return {
      collectiveId,
      slug: collective.slug,
      status: 'OK_ZERO_BALANCE',
    };
  }

  // If multiple non-zero balances, flag as multi-currency
  if (nonZeroBalances.length > 1) {
    return {
      collectiveId,
      slug: collective.slug,
      status: 'ERROR_MULTI_CURRENCY',
      details: `Multiple non-zero balances: ${JSON.stringify(nonZeroBalances)}`,
    };
  }

  // Has non-zero balance but no carryforward - MISSING
  const balanceEntry = nonZeroBalances[0];
  return {
    collectiveId,
    slug: collective.slug,
    status: 'MISSING',
    balance: balanceEntry.balance,
    hostCurrency: balanceEntry.hostCurrency,
    details: `Balance: ${(balanceEntry.balance / 100).toFixed(2)} ${balanceEntry.hostCurrency}`,
  };
}

async function main() {
  program.parse();
  const year = parseInt(program.args[0], 10);
  const options = program.opts<{
    host?: number;
    verbose: boolean;
  }>();

  console.log('='.repeat(70));
  console.log(`Carryforward Coverage Verification - Year ${year}`);
  console.log('='.repeat(70));
  console.log(`Checking for carryforward at: ${year + 1}-01-01`);
  if (options.host) {
    console.log(`Host filter: ${options.host}`);
  }
  console.log('');

  // Find collectives to verify
  console.log('Finding collectives with transactions before cutoff date...');
  const collectiveIds = await findCollectivesWithTransactions(year, options.host || null);
  console.log(`Found ${collectiveIds.length} collectives to verify`);
  console.log('');

  if (collectiveIds.length === 0) {
    console.log('No collectives to verify.');
    process.exit(0);
  }

  // Verification dates
  const cutoffDate = moment.utc(`${year + 1}-01-01`).toDate();
  const openingDate = moment
    .utc(`${year + 1}-01-01`)
    .startOf('day')
    .toDate();

  // Verify collectives
  const results: VerificationResult[] = [];
  const statusCounts: Record<string, number> = {
    OK_CARRYFORWARD: 0,
    OK_ZERO_BALANCE: 0,
    OK_NO_HOST_TRANSACTIONS: 0,
    MISSING: 0,
    ERROR_MULTI_CURRENCY: 0,
  };

  const missing: VerificationResult[] = [];
  const multiCurrency: VerificationResult[] = [];

  console.log(`Verifying ${collectiveIds.length} collectives...`);
  console.log('');

  for (let i = 0; i < collectiveIds.length; i++) {
    const collectiveId = collectiveIds[i];
    const result = await verifyCollective(collectiveId, cutoffDate, openingDate);

    results.push(result);
    statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;

    if (result.status === 'MISSING') {
      missing.push(result);
    } else if (result.status === 'ERROR_MULTI_CURRENCY') {
      multiCurrency.push(result);
    }

    if (options.verbose || result.status === 'MISSING' || result.status === 'ERROR_MULTI_CURRENCY') {
      const statusEmoji = result.status.startsWith('OK_') ? '✓' : result.status === 'MISSING' ? '✗' : '⚠';
      console.log(
        `[${i + 1}/${collectiveIds.length}] ${statusEmoji} ${result.slug} (${result.collectiveId}): ${result.status}${result.details ? ` - ${result.details}` : ''}`,
      );
    } else if ((i + 1) % 500 === 0) {
      // Progress indicator every 500 collectives
      console.log(`[${i + 1}/${collectiveIds.length}] Verifying...`);
    }
  }

  // Print summary
  console.log('');
  console.log('='.repeat(70));
  console.log('Verification Summary');
  console.log('='.repeat(70));
  console.log(`Total verified: ${results.length}`);
  console.log('');
  console.log('Results by status:');
  console.log(`  OK_CARRYFORWARD:          ${statusCounts.OK_CARRYFORWARD} (has carryforward)`);
  console.log(`  OK_ZERO_BALANCE:          ${statusCounts.OK_ZERO_BALANCE} (zero balance, no need)`);
  console.log(`  OK_NO_HOST_TRANSACTIONS:  ${statusCounts.OK_NO_HOST_TRANSACTIONS} (no host transactions)`);
  console.log(`  MISSING:                  ${statusCounts.MISSING} (NEEDS CARRYFORWARD)`);
  console.log(`  ERROR_MULTI_CURRENCY:     ${statusCounts.ERROR_MULTI_CURRENCY} (NEEDS MANUAL REVIEW)`);

  const totalOk = statusCounts.OK_CARRYFORWARD + statusCounts.OK_ZERO_BALANCE + statusCounts.OK_NO_HOST_TRANSACTIONS;
  const coverage = ((totalOk / results.length) * 100).toFixed(2);
  console.log('');
  console.log(`Coverage: ${coverage}% (${totalOk}/${results.length})`);

  if (missing.length > 0) {
    console.log('');
    console.log('='.repeat(70));
    console.log(`Collectives MISSING carryforward (${missing.length}):`);
    console.log('='.repeat(70));
    for (const m of missing.slice(0, 50)) {
      // Show first 50
      console.log(`  ${m.slug} (${m.collectiveId}): ${m.details}`);
    }
    if (missing.length > 50) {
      console.log(`  ... and ${missing.length - 50} more`);
    }
  }

  if (multiCurrency.length > 0) {
    console.log('');
    console.log('='.repeat(70));
    console.log(`Collectives with MULTI-CURRENCY issues (${multiCurrency.length}):`);
    console.log('='.repeat(70));
    for (const m of multiCurrency.slice(0, 50)) {
      // Show first 50
      console.log(`  ${m.slug} (${m.collectiveId}): ${m.details}`);
    }
    if (multiCurrency.length > 50) {
      console.log(`  ... and ${multiCurrency.length - 50} more`);
    }
  }

  // Final verdict
  console.log('');
  console.log('='.repeat(70));
  if (missing.length === 0 && multiCurrency.length === 0) {
    console.log('✓ VERIFICATION PASSED - 100% coverage achieved!');
    console.log(`  Safe to enable balanceCarryforwardDate config for ${year + 1}-01-01`);
    process.exit(0);
  } else {
    console.log('✗ VERIFICATION FAILED - Issues need to be resolved:');
    if (missing.length > 0) {
      console.log(`  - ${missing.length} collectives need carryforward transactions`);
      console.log(`    Run: npm run script scripts/carryforward/create-carryforward.ts ${year}`);
    }
    if (multiCurrency.length > 0) {
      console.log(`  - ${multiCurrency.length} collectives need manual review (multi-currency)`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
