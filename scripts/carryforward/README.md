# Balance Carryforward Scripts

Scripts for creating and verifying balance carryforward transactions.

## What is Balance Carryforward?

Balance carryforward creates a pair of transactions at year-end:

- **Closing (DEBIT)**: Zeroes out the balance at Dec 31 23:59:59
- **Opening (CREDIT)**: Re-establishes the balance at Jan 1 00:00:00

This allows balance queries to only scan transactions from the carryforward date forward, improving performance for collectives with long transaction histories.

## Scripts

### create-carryforward.ts

Creates carryforward transactions for one or all collectives.

```bash
# Single collective
npm run script scripts/carryforward/create-carryforward.ts 2019 --collective my-collective
npm run script scripts/carryforward/create-carryforward.ts 2019 --collective 12345 --dry-run

# All collectives (batch mode)
npm run script scripts/carryforward/create-carryforward.ts 2019 --dry-run
npm run script scripts/carryforward/create-carryforward.ts 2019 --host 123 --limit 100 --verbose
```

**Options:**
| Option | Description |
|--------|-------------|
| `--collective <id\|slug>` | Process a single collective |
| `--dry-run` | Preview without creating transactions |
| `--host <id>` | Filter by host (batch mode) |
| `--limit <n>` | Process max N collectives (batch mode) |
| `--offset <n>` | Skip first N collectives (batch mode) |
| `--verbose` | Show all results, not just errors |

**Statuses:**

- `CREATED` - Carryforward transactions created
- `SKIPPED_ZERO_BALANCE` - Nothing to carry forward
- `SKIPPED_ALREADY_EXISTS` - Carryforward already exists for this date
- `SKIPPED_NO_HOST_TRANSACTIONS` - No transactions with a host before cutoff
- `ERROR_MULTI_CURRENCY` - Multiple currencies/hosts, requires manual review

### verify-carryforward.ts

Verifies that all collectives have carryforwards for a given year.

```bash
npm run script scripts/carryforward/verify-carryforward.ts 2019
npm run script scripts/carryforward/verify-carryforward.ts 2019 --host 123 --verbose
```

**Options:**
| Option | Description |
|--------|-------------|
| `--host <id>` | Filter by host |
| `--verbose` | Show all collectives, not just problems |

## Typical Workflow

```bash
# 1. Preview what would happen
npm run script scripts/carryforward/create-carryforward.ts 2019 --dry-run

# 2. Create carryforwards
npm run script scripts/carryforward/create-carryforward.ts 2019

# 3. Verify 100% coverage
npm run script scripts/carryforward/verify-carryforward.ts 2019

# 4. Fix any issues individually
npm run script scripts/carryforward/create-carryforward.ts 2019 --collective problem-collective
```

## Library

The core logic lives in `server/lib/ledger/carryforward.ts`:

- `computeCarryforwardBalance()` - Computes balance without side effects (used for dry-run)
- `createBalanceCarryforward()` - Creates the actual transactions
- `getBalancesByHostAndCurrency()` - Helper for balance verification
