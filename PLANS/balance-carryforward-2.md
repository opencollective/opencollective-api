# Plan: Incremental Balance Carryforward (v2)

> **Relationship to v1**: This is a **simplification/reimplementation** of `balance-carryforward.md`. We keep the foundation (transaction kind, `createBalanceCarryforward()` function) but replace the complex per-collective loader approach with a simpler global config-based approach.

## Goal

Close the books year by year (2017 → 2018 → 2019 → ...). For each year:

1. Create carryforward transactions for ALL collectives at Dec 31
2. Verify 100% coverage
3. Set global config to use that date as startDate for balance queries

## Key Principles

1. **Non-destructive**: Carryforward doesn't change balance (DEBIT cancels old, CREDIT opens new)
2. **Year by year**: Close 2017 first, verify, enable. Then 2018, etc.
3. **Global config**: Once ALL collectives processed, set `balanceCarryforwardDate`
4. **Historical FX rates**: Use rate at carryforward date (already implemented)
5. **No exceptions**: Every collective must be processed or verified as "nothing to close"

## What Changed from v1

| v1 (Complex)                                 | v2 (Simplified)                    |
| -------------------------------------------- | ---------------------------------- |
| Per-collective carryforward dates via loader | Global config date for all         |
| Historical query support (endDate param)     | Not needed - we're closing history |
| Complex grouping by carryforward date        | Single date for all collectives    |
| Dynamic per-request lookups                  | Static config value                |

## Edge Cases to Handle

| Case                               | Current Behavior     | Required Behavior                                             |
| ---------------------------------- | -------------------- | ------------------------------------------------------------- |
| Zero balance at cutoff             | Returns null, no txn | OK - nothing to carry forward                                 |
| Multi-currency balances            | Throws error         | Flag for manual review, don't block                           |
| No host in transactions            | Throws error         | Skip - no fiscal balance exists                               |
| No transactions before cutoff      | N/A                  | Skip - nothing to close                                       |
| Already has carryforward           | Throws error         | Skip gracefully                                               |
| Deleted collective                 | Skipped by script    | Verify: if has transactions before cutoff, needs carryforward |
| Inactive org, becomes active later | N/A                  | Fine - if no pre-cutoff txns, nothing needed                  |
| Backdated transaction added later  | N/A                  | **RISK** - see mitigation below                               |

### Risk: Backdated Transactions

If someone adds a transaction backdated before the carryforward date AFTER we've enabled the config, that transaction would be skipped in balance calculations.

**Mitigations:**

1. **Prevent backdating**: Add validation to reject transactions before `balanceCarryforwardDate`
2. **Or**: When a backdated transaction is added, require creating a new carryforward
3. **Or**: Accept this as a data integrity rule - "don't backdate before closed period"

**Recommendation**: Add validation in Transaction model to reject `createdAt < balanceCarryforwardDate` (configurable, can be overridden for migrations/fixes).

## Implementation

### Phase 1: Keep Existing Foundation (Already Done)

- [x] `BALANCE_CARRYFORWARD` transaction kind
- [x] `createBalanceCarryforward()` function
- [x] Migration for enum
- [x] Single-collective script

### Phase 2: Batch Processing Script

**File: `scripts/batch-create-carryforward.ts`**

```
Usage: npm run script scripts/batch-create-carryforward.ts <year> [options]
Options:
  --dry-run     Show what would be done without creating transactions
  --host <id>   Only process collectives under this host
  --limit <n>   Process max N collectives
  --offset <n>  Skip first N collectives
```

**Logic:**

1. Find all Collectives/Organizations with transactions before Jan 1 of (year+1)
2. For each collective:
   - Check if already has carryforward at this date → skip
   - Try createBalanceCarryforward()
   - On success → log
   - On error → log to exceptions file with reason
3. Output summary: processed, skipped, failed

### Phase 3: Verification Script

**File: `scripts/verify-carryforward-coverage.ts`**

Before enabling config, verify 100% coverage:

```
Usage: npm run script scripts/verify-carryforward-coverage.ts <year>
```

**Logic:**

1. Find all collectives with transactions with a HostCollectiveId before Jan 1 of (year+1)
2. For each, check:
   - Has carryforward CREDIT at Jan 1 of (year+1)? → OK
   - Has zero balance at Dec 31 of year? → OK (nothing to carry)
   - Otherwise → MISSING (needs manual attention)
3. Output: list of any collectives that need attention

**Categories:**

- `OK_CARRYFORWARD`: Has carryforward transaction
- `OK_ZERO_BALANCE`: Balance was zero, no carryforward needed
- `OK_NO_HOST_TRANSACTIONS`: Has transactions but none with HostCollectiveId (no fiscal balance)
- `MISSING`: Has non-zero balance but no carryforward - **NEEDS ATTENTION**
- `ERROR_MULTI_CURRENCY`: Has multi-currency balances - **NEEDS MANUAL REVIEW**

**The rule**: Config can only be enabled when MISSING count = 0

### Phase 4: Simplify budget.js

**File: `server/lib/budget.js`**

Replace complex loader logic with simple config-based approach:

```javascript
import config from 'config';

// Global carryforward date from config (null = disabled)
const BALANCE_CARRYFORWARD_DATE = config.ledger?.balanceCarryforwardDate
  ? new Date(config.ledger.balanceCarryforwardDate)
  : null;

export async function getBalances(collectiveIds, options) {
  // ... existing fast path logic ...

  // For the direct/slow path, use carryforward date as startDate
  const startDate = BALANCE_CARRYFORWARD_DATE;

  const results = await sumCollectivesTransactions(missingCollectiveIds, {
    column,
    startDate, // Skips all transactions before this date
    endDate,
    includeChildren,
    withBlockedFunds,
    excludeRefunds: false,
    hostCollectiveId,
  });

  return { ...fastResults, ...results };
}
```

### Phase 5: Cleanup

Remove:

- `generateLatestCarryforwardDateLoader` in `server/graphql/loaders/transactions.ts`
- Loader registration in `server/graphql/loaders/index.ts`
- `server/lib/loaders.ts` (if only used for carryforward)
- Complex grouping logic in `getBalances()`

## Files to Modify/Create

| File                                      | Change                                     |
| ----------------------------------------- | ------------------------------------------ |
| `scripts/batch-create-carryforward.ts`    | NEW: Batch processing script               |
| `scripts/verify-carryforward-coverage.ts` | NEW: Verification script                   |
| `server/lib/budget.js`                    | Simplify to use config-based startDate     |
| `server/lib/ledger/carryforward.ts`       | Handle edge cases more gracefully          |
| `config/default.js`                       | Add `ledger.balanceCarryforwardDate: null` |
| `server/graphql/loaders/transactions.ts`  | Remove carryforward loader                 |
| `server/graphql/loaders/index.ts`         | Remove loader registration                 |

## Rollout Workflow (Per Year)

```
Year 2017:
1. npm run script scripts/batch-create-carryforward.ts 2017 --dry-run
   → Review output, check exceptions

2. npm run script scripts/batch-create-carryforward.ts 2017
   → Creates carryforward transactions

3. npm run script scripts/verify-carryforward-coverage.ts 2017
   → Must show 100% coverage

4. Handle any exceptions manually
   → Re-run verify until clean

5. Set config: ledger.balanceCarryforwardDate = '2018-01-01'
   → Deploy

6. Verify balances unchanged for sample collectives

Repeat for 2018, 2019, etc.
```

## Verification Commands

```sql
-- Count carryforward transactions by year
SELECT
  DATE_TRUNC('year', "createdAt") as year,
  COUNT(*) as count
FROM "Transactions"
WHERE kind = 'BALANCE_CARRYFORWARD'
GROUP BY 1
ORDER BY 1;

-- Find collectives missing carryforward for 2017
SELECT DISTINCT t."CollectiveId"
FROM "Transactions" t
WHERE t."createdAt" < '2018-01-01'
  AND t."HostCollectiveId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Transactions" cf
    WHERE cf."CollectiveId" = t."CollectiveId"
      AND cf.kind = 'BALANCE_CARRYFORWARD'
      AND cf.type = 'CREDIT'
      AND cf."createdAt" = '2018-01-01'
  );
```
