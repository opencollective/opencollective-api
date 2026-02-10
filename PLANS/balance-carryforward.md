# Plan: Balance Carryforward

## Problem Statement

Currently, balance calculations process the entire transaction history of a collective, which:

- Becomes slower as collectives accumulate more transactions
- Requires complex checkpoint/materialized view architecture for optimization
- Makes it difficult to audit or reconcile balances at specific points in time

## Business Context

**Why now?** As collectives age and accumulate transactions, balance queries in the direct path become slower. This affects page load times, API response times, and report generation.

**Who benefits?**

- Long-running collectives with thousands of transactions
- Hosts running reports across many collectives
- Platform performance overall

**Who decides when to apply?** This is an internal operational tool. Engineering/Operations decides which collectives to apply carryforward to, based on transaction count or performance metrics.

**Visibility**: Carryforward transactions are visible in the public ledger and transaction exports. This provides transparency for accountants and auditors who expect to see opening balance entries. The transactions are clearly labeled as "Balance carryforward" entries.

## Risk Assessment

| Risk                                      | Likelihood | Impact | Mitigation                                                                   |
| ----------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------- |
| Balance discrepancy after carryforward    | Low        | High   | Extensive testing, verify balance before/after, pre-creation validation      |
| Breaking existing reports/exports         | Medium     | Medium | Test report outputs, ensure carryforward transactions display correctly      |
| Irreversible data change                  | Low        | High   | Soft delete on rollback, keep full transaction history                       |
| User confusion about carryforward entries | Low        | Low    | Clear descriptions ("Balance carryforward - Opening/Closing"), documentation |

## Proposed Solution

Implement a "balance carryforward" mechanism similar to bank statements:

1. At a specific date (e.g., December 31st last second of the day), create a DEBIT transaction that closes the period
2. Immediately after (e.g., January 1st first second of the day), create a CREDIT transaction with the opening balance
3. Balance calculations query the latest carryforward date from transactions and use it as startDate
4. Balance calculations only need to process transactions from the carryforward date forward

### Example

```
Before carryforward (Dec 31, 2024):
  Balance: $10,000 (sum of 5,000 transactions over 5 years)

Carryforward transactions:
  Dec 31, 2024 23:59:59.999 UTC - DEBIT  $10,000 (kind: BALANCE_CARRYFORWARD) - Closing balance
  Jan 1,  2025 00:00:00.000 UTC - CREDIT $10,000 (kind: BALANCE_CARRYFORWARD) - Opening balance

After carryforward:
  Balance: $10,000 (sum of 2 transactions + new activity)
```

The transactions will be marked as `isInternal: true` to exclude them from key metrics (like total contributions, total spending) while still appearing in the public ledger for transparency and audit purposes.

## Key Design Decisions (Lessons Learned)

### 1. No Column on Collective Model

**Decision**: Do NOT store `lastBalanceCarryforwardAt` on the Collective model.

**Rationale**:

- Carryforward transactions already exist in the database - no need to duplicate the date
- A loader can efficiently query the latest carryforward date from transactions
- This approach naturally supports multiple carryforwards at different dates
- Historical balance queries automatically use the right carryforward (the latest one before the query's endDate)

### 2. Multiple Carryforwards Allowed

**Decision**: A collective can have multiple carryforwards at different dates (but not at the same date).

**Rationale**:

- Allows annual carryforwards (e.g., every December 31st)
- Allows adding carryforwards in the past if needed
- The loader automatically finds the relevant carryforward for any query

### 3. Historical Host Lookup

**Decision**: Use the host from the most recent transaction before the carryforward date, not the current host.

**Rationale**:

- Collectives can change hosts over time
- The carryforward should use the host that was holding the funds at that point in time
- Query the most recent transaction with a host before the carryforward date to determine the historical host

### 4. Balance Verification Before Creation

**Decision**: Before creating a carryforward, verify that `getBalancesByHostAndCurrency()` matches `getBalanceAmount()`.

**Rationale**:

- Catches data inconsistencies before creating potentially incorrect carryforward
- Provides confidence that the carryforward amount is correct
- Throws error with details for manual investigation if mismatch

### 5. Single Non-Zero Balance Only

**Decision**: If there are multiple non-zero balances across different hosts/currencies, throw an error.

**Rationale**:

- Cannot sum balances in different currencies
- Multi-currency is not officially supported
- Requires manual review to handle edge cases

### 6. UTC Dates

**Decision**: Use `moment.utc()` for all carryforward date calculations.

**Rationale**:

- Ensures consistent accounting boundaries regardless of server timezone
- Closing: `2024-12-31T23:59:59.999Z`
- Opening: `2025-01-01T00:00:00.000Z`

### 7. Loader-Based Approach

**Decision**: Use a parameterized DataLoader for querying carryforward dates.

**Rationale**:

- Efficient batch querying when calculating balances for multiple collectives
- Parameterized by `endDate` to find the relevant carryforward for historical queries
- Falls back to direct SQL query when loaders aren't available (scripts, cron jobs)

### 8. Code Organization

**Decision**: Put carryforward logic in `server/lib/ledger/carryforward.ts`, not in budget.js.

**Rationale**:

- Keeps budget.js focused on balance calculations
- Carryforward is a ledger/accounting concept
- Cleaner separation of concerns

## Current Architecture

### Two Balance Calculation Paths

1. **Fast path (materialized view)**: `getCurrentCollectiveBalances()` using `CurrentCollectiveBalance` view
2. **Direct path**: `sumCollectivesTransactions()` summing all transactions

Both paths are in `server/lib/budget.js`. Only the direct path uses the carryforward optimization.

### Key Files

- `server/lib/budget.js` - Balance calculation logic, integrates with carryforward loader
- `server/lib/ledger/carryforward.ts` - Carryforward creation logic
- `server/graphql/loaders/transactions.ts` - Carryforward date loader
- `server/models/Transaction.ts` - Transaction model
- `server/constants/transaction-kind.ts` - Transaction kinds enum

## Implementation Plan

### Phase 1: Database Schema Changes

#### 1.1 Add New Transaction Kind

File: `server/constants/transaction-kind.ts`

```typescript
export enum TransactionKind {
  // ... existing kinds
  BALANCE_CARRYFORWARD = 'BALANCE_CARRYFORWARD',
}
```

#### 1.2 Migration

Create migration: `npm run db:migration:create -- --name add-balance-carryforward-support`

The migration should:

1. **Add `BALANCE_CARRYFORWARD` to the database enum**
   - `ALTER TYPE "enum_Transactions_kind" ADD VALUE IF NOT EXISTS 'BALANCE_CARRYFORWARD'`

2. **Down migration**: Cannot remove enum values in PostgreSQL, so no-op

### Phase 2: Create Carryforward Loader

File: `server/graphql/loaders/transactions.ts`

Add `generateLatestCarryforwardDateLoader()` that:

1. Accepts optional `endDate` parameter via `buildLoader({ endDate })`
2. Batches queries by collectiveId
3. Returns the latest BALANCE_CARRYFORWARD CREDIT (opening) transaction date before endDate
4. Returns `null` if no carryforward exists

```typescript
export const generateLatestCarryforwardDateLoader = cachedLoaders => ({
  buildLoader({ endDate = null } = {}) {
    const key = `latestCarryforwardDate-${endDate?.toISOString() || 'null'}`;
    if (!cachedLoaders[key]) {
      cachedLoaders[key] = new DataLoader(async collectiveIds => {
        // Query MAX(createdAt) grouped by CollectiveId
        // WHERE kind = 'BALANCE_CARRYFORWARD' AND type = 'CREDIT'
        // AND createdAt <= endDate (if specified)
      });
    }
    return cachedLoaders[key];
  },
});
```

Register in `server/graphql/loaders/index.ts` under `Transaction`.

### Phase 3: Create Carryforward Function

File: `server/lib/ledger/carryforward.ts`

#### 3.1 getBalancesByHostAndCurrency()

Returns balances grouped by HostCollectiveId and hostCurrency for verification:

```typescript
export async function getBalancesByHostAndCurrency(
  collectiveId: number,
  { endDate = null } = {},
): Promise<Array<{ HostCollectiveId: number; hostCurrency: string; balance: number }>>;
```

#### 3.2 createBalanceCarryforward()

```typescript
export async function createBalanceCarryforward(
  collective: Collective,
  carryforwardDate: Date,
): Promise<CarryforwardResult | null>;
```

The function should:

1. Validate carryforward date is in the past
2. Wrap in database transaction with row lock on collective
3. Check for existing carryforward at the same date (prevent duplicates)
4. Find historical host from most recent transaction before carryforward date
5. Get balances by host/currency
6. Validate: only one non-zero balance allowed (error if multiple)
7. Verify balance matches `getBalanceAmount()` (error if mismatch)
8. If balance is zero, return null
9. Create closing DEBIT transaction (end of day UTC)
10. Create opening CREDIT transaction (start of next day UTC)
11. Return both transactions and balance info

Transaction fields:

- `kind`: `BALANCE_CARRYFORWARD`
- `isInternal`: `true` (excludes from metrics)
- `TransactionGroup`: shared UUID linking the pair
- `CollectiveId` = `FromCollectiveId` = the collective (self-referential)
- `HostCollectiveId`: historical host from transactions
- All fee fields: 0
- `taxAmount`: 0

### Phase 4: Integrate into Balance Calculations

File: `server/lib/budget.js`

Update `getBalances()` to:

1. Use the carryforward loader (if available) or direct query
2. For each collective, find the latest carryforward date before the query's endDate
3. Group collectives by carryforward date for efficient batch querying
4. Pass carryforward date as `startDate` to `sumCollectivesTransactions()`
5. Skip optimization if `includeChildren` is true (complexity)

```javascript
let carryforwardDates;
if (loaders) {
  carryforwardDates = await loaders.Transaction.latestCarryforwardDate
    .buildLoader({ endDate })
    .loadMany(missingCollectiveIds);
} else {
  // Fallback: direct SQL query
}
```

### Phase 5: Carryforward Script

File: `scripts/create-balance-carryforward.ts`

A script that creates a balance carryforward for a single collective:

1. Accepts collective slug or id as argument
2. Accepts carryforward date as argument (YYYY-MM-DD format)
3. Validates the collective exists and has a host
4. Shows balances by host/currency before carryforward
5. Calls `createBalanceCarryforward()`
6. Verifies balance unchanged after carryforward
7. Logs detailed results

Usage:

```bash
npm run script scripts/create-balance-carryforward.ts webpack 2024-12-31
```

## Files to Modify/Create

| File                                     | Change                                             |
| ---------------------------------------- | -------------------------------------------------- |
| `server/constants/transaction-kind.ts`   | Add `BALANCE_CARRYFORWARD`                         |
| `server/lib/ledger/carryforward.ts`      | NEW: carryforward creation logic                   |
| `server/lib/budget.js`                   | Use carryforward loader for startDate optimization |
| `server/graphql/loaders/transactions.ts` | Add `generateLatestCarryforwardDateLoader`         |
| `server/graphql/loaders/index.ts`        | Register carryforward loader                       |
| Migration file                           | Add enum value only                                |
| `scripts/create-balance-carryforward.ts` | NEW: single collective carryforward script         |

## Tests

File: `test/server/lib/budget.test.ts`

### getBalancesByHostAndCurrency()

- Returns balances grouped by host and currency
- Respects endDate parameter
- Returns empty array for collective with no transactions

### createBalanceCarryforward()

- Creates DEBIT and CREDIT transaction pair with correct amounts
- Returns null when balance is zero
- Transactions have kind `BALANCE_CARRYFORWARD` and `isInternal: true`
- Transactions share the same `TransactionGroup`
- Transactions have correct historical `HostCollectiveId`
- Closing transaction dated before opening transaction (UTC)
- Errors if collective has no transactions with a host
- Errors if carryforward date is in the future
- Errors if carryforward already exists at the same date
- Handles negative balances correctly
- Allows multiple carryforwards at different dates

### Balance calculation with carryforward

- `getBalances()` returns same balance before and after carryforward
- Balance is correct after new transactions are added post-carryforward
- Historical balance query with endDate before carryforward uses full transaction history

### Metric exclusion

- Carryforward transactions are excluded from `sumCollectivesTransactions` when `excludeInternals` is true
- Carryforward transactions are included in ledger queries (`excludeInternals: false`)

## Limitations (v1)

- **Single currency only**: If multiple non-zero balances exist across hosts/currencies, throws error requiring manual review
- **Requires host**: Collectives without transactions with a host cannot have carryforward
- **Historical queries**: Balance queries with endDate before any carryforward fall back to full transaction history
- **No duplicate dates**: Cannot create two carryforwards at the same date

## Verification Before Use

Before applying carryforward to any production collective:

1. **Balance verification**: The function automatically verifies balance matches before creating
2. **Test on staging**: Apply to representative collectives on staging first
3. **Verify ledger display**: Ensure carryforward transactions appear correctly in the public ledger
4. **Verify exports**: Ensure transaction exports include carryforward entries correctly
5. **Check GraphQL**: Verify balance queries return expected values via API

## Observability

- **Logging**: Script outputs detailed info including balances by host/currency
- **Verification**: Script verifies balance unchanged after carryforward
- **Query for monitoring**:
  ```sql
  SELECT COUNT(*) FROM "Transactions" WHERE kind = 'BALANCE_CARRYFORWARD' AND "deletedAt" IS NULL;
  SELECT "CollectiveId", COUNT(*) as carryforward_count
  FROM "Transactions"
  WHERE kind = 'BALANCE_CARRYFORWARD' AND type = 'CREDIT' AND "deletedAt" IS NULL
  GROUP BY "CollectiveId";
  ```

## Out of Scope

- Automatic/scheduled carryforward (manual operation only for v1)
- Multi-currency balance carryforward in single operation
- Host-level batch operations
- Column on Collective model (not needed - use loader)
- Special UI treatment for carryforward transactions

## Future Enhancements

- **`undoBalanceCarryforward()` function**: Rollback capability that soft deletes carryforward transactions
- **Batch carryforward script**: Apply carryforward to multiple collectives
- **Dry-run mode**: Preview what carryforward would do without committing
- **Multi-currency support**: Handle collectives with balances in multiple currencies

## Success Criteria

- Balance calculations use carryforward date as startDate via loader
- `createBalanceCarryforward()` creates proper transaction pairs with all required fields
- No balance discrepancies: balance before carryforward equals balance after
- All validations work correctly (duplicate date, future date, no host, balance mismatch)
- Carryforward transactions appear correctly in ledger and exports
- Carryforward transactions are excluded from contribution/spending metrics (via `isInternal`)
- Works in both web context (with loaders) and scripts (with fallback query)
