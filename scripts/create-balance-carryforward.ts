/**
 * Script to create a balance carryforward for a collective.
 *
 * Usage:
 *   npm run script scripts/create-balance-carryforward.ts <collective-slug-or-id> <carryforward-date>
 *
 * Arguments:
 *   - collective-slug-or-id: The slug or ID of the collective
 *   - carryforward-date: The end-of-period date for carryforward (e.g., "2024-12-31")
 *
 * Example:
 *   npm run script scripts/create-balance-carryforward.ts my-collective 2024-12-31
 */

import '../server/env';

import moment from 'moment';

import { getBalances } from '../server/lib/budget';
import { createBalanceCarryforward, getBalancesByHostAndCurrency } from '../server/lib/ledger/carryforward';
import models from '../server/models';

const main = async () => {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      'Usage: npm run script scripts/create-balance-carryforward.ts <collective-slug-or-id> <carryforward-date>',
    );
    console.error('Example: npm run script scripts/create-balance-carryforward.ts my-collective 2024-12-31');
    process.exit(1);
  }

  const collectiveIdentifier = args[0];
  const carryforwardDateStr = args[1];

  // Parse the carryforward date
  const carryforwardDate = moment(carryforwardDateStr, 'YYYY-MM-DD', true);
  if (!carryforwardDate.isValid()) {
    console.error(`Invalid date format: ${carryforwardDateStr}. Please use YYYY-MM-DD format.`);
    process.exit(1);
  }

  // Set to end of day (23:59:59.999)
  const endOfPeriodDate = carryforwardDate.endOf('day').toDate();

  // Find the collective by slug or ID
  let collective;
  const collectiveId = parseInt(collectiveIdentifier, 10);
  if (!isNaN(collectiveId)) {
    collective = await models.Collective.findByPk(collectiveId);
  } else {
    collective = await models.Collective.findOne({ where: { slug: collectiveIdentifier.toLowerCase() } });
  }

  if (!collective) {
    console.error(`Collective not found: ${collectiveIdentifier}`);
    process.exit(1);
  }

  console.log(`Found collective: ${collective.name} (slug: ${collective.slug}, id: ${collective.id})`);

  // Validate collective state
  if (!collective.HostCollectiveId) {
    console.error(`Error: Collective "${collective.slug}" has no host. Balance carryforward requires a host.`);
    process.exit(1);
  }

  if (collective.deletedAt) {
    console.error(`Error: Collective "${collective.slug}" has been deleted.`);
    process.exit(1);
  }

  // Get balance before carryforward
  const balanceBeforeResult = await getBalances([collective.id], {
    useMaterializedView: false,
  });
  const balanceBefore = balanceBeforeResult[collective.id]?.value || 0;
  const currencyBefore = balanceBeforeResult[collective.id]?.currency || 'USD';

  console.log(`\nCurrent balance: ${(balanceBefore / 100).toFixed(2)} ${currencyBefore}`);
  console.log(`Carryforward date: ${carryforwardDateStr} (end of day: ${endOfPeriodDate.toISOString()})`);

  // Get balances by host and currency for verification
  const balancesByHostBefore = await getBalancesByHostAndCurrency(collective.id, { endDate: endOfPeriodDate });
  console.log(`\nBalances by host/currency (before carryforward):`);
  if (balancesByHostBefore.length === 0) {
    console.log('  No balances found');
  } else {
    for (const b of balancesByHostBefore) {
      console.log(`  Host ${b.HostCollectiveId}: ${(b.balance / 100).toFixed(2)} ${b.hostCurrency}`);
    }
  }

  // Create the carryforward
  console.log('\nCreating balance carryforward...');

  try {
    const result = await createBalanceCarryforward(collective, endOfPeriodDate);

    if (result === null) {
      console.log('\nNo carryforward created - balance is zero.');
      process.exit(0);
    }

    console.log('\nCarryforward created successfully!');
    console.log(`  Closing transaction ID: ${result.closingTransaction.id}`);
    console.log(`  Opening transaction ID: ${result.openingTransaction.id}`);
    console.log(`  Balance carried forward: ${(result.balance / 100).toFixed(2)} ${currencyBefore}`);
    console.log(`  Transaction group: ${result.closingTransaction.TransactionGroup}`);
    console.log(`  Carryforward HostCollectiveId: ${result.closingTransaction.HostCollectiveId}`);
    console.log(`  Carryforward hostCurrency: ${result.closingTransaction.hostCurrency}`);

    console.log(`\nBalances by host/currency (used for carryforward):`);
    for (const b of result.balancesByHost) {
      const marker = b.HostCollectiveId === result.closingTransaction.HostCollectiveId ? ' <-- carried forward' : '';
      console.log(`  Host ${b.HostCollectiveId}: ${(b.balance / 100).toFixed(2)} ${b.hostCurrency}${marker}`);
    }
    if (result.balancesByHost.length > 1) {
      console.log(`\n⚠️  WARNING: Multiple hosts/currencies found. Only one host was used for carryforward.`);
      console.log(`   Review the balances above to ensure all funds are accounted for.`);
    }

    // Verify balance after carryforward
    const balanceAfterResult = await getBalances([collective.id], {
      useMaterializedView: false,
    });
    const balanceAfter = balanceAfterResult[collective.id]?.value || 0;
    const currencyAfter = balanceAfterResult[collective.id]?.currency || 'USD';

    console.log(`\nVerification:`);
    console.log(`  Balance before: ${(balanceBefore / 100).toFixed(2)} ${currencyBefore}`);
    console.log(`  Balance after:  ${(balanceAfter / 100).toFixed(2)} ${currencyAfter}`);

    if (balanceBefore === balanceAfter) {
      console.log('\n✓ Balance verification passed - balance unchanged after carryforward.');
    } else {
      console.error(
        `\n✗ WARNING: Balance changed after carryforward! Difference: ${((balanceAfter - balanceBefore) / 100).toFixed(2)} ${currencyAfter}`,
      );
    }
  } catch (error) {
    console.error(`\nError creating carryforward: ${error.message}`);
    process.exit(1);
  }

  process.exit(0);
};

if (require.main === module) {
  main();
}

export default main;
