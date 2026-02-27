# Transactions Table Indexes

Inventory of all indexes on the `Transactions` table with usage analysis.

No indexes are defined at the Sequelize model level; all are managed through migrations.

## Table Overview (production, 2026-02-26)

- **Table data:** 4,251 MB
- **Total indexes:** 6,605 MB (155% of data size)
- **Total with TOAST:** 18 GB
- **Estimated rows:** 11,747,127

## Index Statistics (production)

Sorted by size descending. Scan counts are since server start on **2025-12-22** (66 days). Stats have never been explicitly reset.

| Index                                                                                                                                               | Size   | Entries    | Scans       | Notes                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------- | ---------------------------------------------------------------------- |
| **Critical**                                                                                                                                        |        |            |             | _4 indexes_                                                            |
| [`transactions_total_donated`](#transactions_total_donated)                                                                                         | 25 MB  | 1,976,087  | 741,019,659 | Highest scan count by far, tiny index                                  |
| [`transactions__ContributorsQuery`](#transactions__contributorsquery)                                                                               | 47 MB  | 3,486,244  | 312,623,962 | Highest scan count!                                                    |
| [`transactions__using_gift_card_from_collective_id`](#usingvirtualcardfromcollectiveid-renamed-to-transactions__using_gift_card_from_collective_id) | 109 MB | 11,746,103 | 106,952,175 | Very high usage, ContributorsQuery                                     |
| [`CollectiveId-FromCollectiveId-type`](#collectiveid-fromcollectiveid-type)                                                                         | 154 MB | 11,746,103 | 101,970,015 | Very high usage despite EXPLAIN showing seq scan for large collectives |
| **High**                                                                                                                                            |        |            |             | _9 indexes_                                                            |
| [`transactions__order_id`](#transactions__order_id)                                                                                                 | 113 MB | 11,074,618 | 66,757,738  | Very high usage                                                        |
| [`transactions__collective_id`](#transactions__collective_id)                                                                                       | 120 MB | 11,635,299 | 50,612,397  | Very high usage, COUNT queries                                         |
| [`transactions__transaction_group`](#transactions__transaction_group)                                                                               | 181 MB | 11,746,103 | 50,300,836  | High usage, all rows                                                   |
| [`transactions__unrefunded_credits`](#transactions__unrefunded_credits)                                                                             | 188 MB | 5,721,527  | 35,561,309  | High usage, contribution stats                                         |
| [`CollectiveId-type`](#collectiveid-type)                                                                                                           | 129 MB | 11,746,103 | 23,338,851  | High usage, BitmapAnd companion                                        |
| [`transactions__collective_id_created_at_regular`](#transactions__collective_id_created_at_regular)                                                 | 466 MB | 11,635,299 | 14,802,313  | High usage, regular createdAt ordering                                 |
| [`transactions__collective_id_createdAt`](#transactions__collective_id_createdat)                                                                   | 427 MB | 11,635,299 | 13,552,581  | High usage, ROUND epoch ordering                                       |
| [`transactions__is_disputed`](#transactions__is_disputed)                                                                                           | 16 KB  | 0          | 13,030,697  | Extremely selective, high usage, near-zero storage                     |
| [`CurrentCollectiveTransactionStatsIndex`](#currentcollectivetransactionstatsindex)                                                                 | 376 MB | 11,518,229 | 11,627,678  | High usage, balance views                                              |
| **Moderate**                                                                                                                                        |        |            |             | _6 indexes_                                                            |
| [`txn_group_primary_testing`](#txn_group_primary_testing)                                                                                           | 322 MB | 4,500,324  | 9,830,298   | Host transactions report lateral join, needs formalization             |
| [`transactions__non_debt`](#transactions__non_debt)                                                                                                 | 107 MB | 11,040,163 | 7,681,909   | Moderate usage                                                         |
| [`transactions__expense_payment_date`](#transactions__expense_payment_date)                                                                         | 7 MB   | 230,616    | 3,140,808   | Moderate usage, tiny                                                   |
| [`transactions_expense_id`](#transactions_expense_id)                                                                                               | 12 MB  | 558,332    | 2,563,823   | Moderate usage                                                         |
| [`transactions_expenses_tags_index`](#transactions_expenses_tags_index)                                                                             | 2 MB   | 230,616    | 715,458     | Tiny, moderate usage                                                   |
| [`transactions_kind`](#transactions_kind)                                                                                                           | 108 MB | 11,635,299 | 361,531     | Low selectivity, BitmapAnd companion                                   |
| **Low**                                                                                                                                             |        |            |             | _17 indexes_                                                           |
| [`transactions_uuid`](#transactions_uuid)                                                                                                           | 540 MB | 11,746,103 | 89,715      | UNIQUE, all rows                                                       |
| [`Transactions_HostCollectiveId_CollectiveId`](#transactions_hostcollectiveid_collectiveid)                                                         | 474 MB | 11,635,299 | 65,786      | Covering (INCLUDE CollectiveId)                                        |
| [`transactions__host_collective_id_createdAt`](#transactions__host_collective_id_createdat)                                                         | 287 MB | 8,173,722  | 65,069      | ROUND epoch, host filter                                               |
| [`transactions__host_collective_id`](#transactions__host_collective_id)                                                                             | 74 MB  | 8,173,722  | 42,389      | Moderate usage                                                         |
| [`transactions__data_paypal_capture_id`](#transactions__data_paypal_capture_id)                                                                     | 24 MB  | 670,703    | 25,350      | Webhook + cron triggered                                               |
| [`transactions__host_collective_id_created_at_regular`](#transactions__host_collective_id_created_at_regular)                                       | 442 MB | 11,635,299 | 19,373      | Host + regular createdAt                                               |
| [`transactions__contributions_fromcollective_to_host`](#transactions__contributions_fromcollective_to_host)                                         | 165 MB | 3,902,056  | 16,473      | Low usage                                                              |
| [`transactions__stripe_charge_id`](#transactions__stripe_charge_id)                                                                                 | 141 MB | 3,229,396  | 10,659      | Webhook-triggered                                                      |
| [`transactions__collective_clearedAt`](#transactions__collective_clearedat)                                                                         | 260 MB | 11,635,299 | 10,274      | Low usage                                                              |
| [`Transactions_Orders_by_date`](#transactions_orders_by_date)                                                                                       | 95 MB  | 1,996,838  | 8,489       | New (2026-02-23), covering INCLUDE                                     |
| [`transactions__payment_method_id`](#transactions__payment_method_id)                                                                               | 70 MB  | 6,662,390  | 2,573       | Low usage                                                              |
| [`transactions__hostCollective_clearedAt`](#transactions__hostcollective_clearedat)                                                                 | 197 MB | 11,635,299 | 199         | Very low usage                                                         |
| [`transactions__stripe_charge_payment_intent`](#transactions__stripe_charge_payment_intent)                                                         | 133 MB | 3,008,177  | 47          | Webhook-triggered, very low                                            |
| [`Transactions_HostCollectiveId_Contributions`](#transactions_hostcollectiveid_contributions)                                                       | 146 MB | 1,992,507  | 25          | Very new (2026-02-24), expected low                                    |
| [`transactions__data__dispute_id`](#transactions__data__dispute_id)                                                                                 | 96 MB  | 3,133      | 19          | HASH, webhook-triggered, very sparse                                   |
| [`transaction_wise_transfer_id`](#transaction_wise_transfer_id)                                                                                     | 10 MB  | 248,235    | 0           | Zero scans                                                             |
| [`transactions__created_by_user_id`](#transactions__created_by_user_id)                                                                             | 117 MB | 11,746,103 | 11,096      | Stripe webhook JOIN, low value vs size                                 |
| **Unused**                                                                                                                                          |        |            |             | _2 indexes_                                                            |
| [`transactions__contributions_date`](#transactions__contributions_date)                                                                             | 60 MB  | 1,976,087  | 36          | **Candidate for removal** (superseded, 60 MB wasted)                   |
| [`transactions__contributions_host_id`](#transactions__contributions_host_id)                                                                       | 78 MB  | 1,976,087  | 12          | **Candidate for removal** (superseded, 78 MB wasted)                   |

**Removal candidates: 138 MB** ([`transactions__contributions_host_id`](#transactions__contributions_host_id) 78 MB + [`transactions__contributions_date`](#transactions__contributions_date) 60 MB, both superseded). [`txn_group_primary_testing`](#txn_group_primary_testing) (322 MB) is actively used by the host transactions report but needs formalization. [`transactions__created_by_user_id`](#transactions__created_by_user_id) (117 MB) is used by Stripe webhook JOINs but low value relative to size.

**Notable observations:**

- [`transaction_wise_transfer_id`](#transaction_wise_transfer_id) has 0 scans and 10 MB. Wise webhooks may not have fired since last stats reset, or the cron may be disabled.
- [`transactions__stripe_charge_payment_intent`](#transactions__stripe_charge_payment_intent) has only 47 scans and 133 MB. Reviews are rare Stripe events.
- [`transactions__hostCollective_clearedAt`](#transactions__hostcollective_clearedat) has only 199 scans but costs 197 MB. The `clearedFrom`/`clearedTo` args with host filter may be rarely used in practice.
- [`transactions__is_disputed`](#transactions__is_disputed) is the most efficient index: 16 KB for 13M scans (extremely selective partial WHERE, 0 matching rows currently).
- [`transactions_total_donated`](#transactions_total_donated) is the most scanned index (741M) at only 25 MB.
- [`CollectiveId-FromCollectiveId-type`](#collectiveid-fromcollectiveid-type) has 102M scans despite EXPLAIN showing seq scan for large collectives, suggesting it works well for smaller collectives.

## Currently Active Indexes

### transactions_total_donated

- **Stats:** 25 MB, 1,976,087 entries, 741,019,659 scans (66 days)
- **Columns:** `OrderId`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND RefundTransactionId IS NULL AND type = 'CREDIT' AND kind IN ('CONTRIBUTION', 'ADDED_FUNDS')`
- **Migration:** [`migrations/20250106143156-transactions-total-donated-index.ts`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250106143156-transactions-total-donated-index.ts)
- **Commit:** [`0873b899`](https://github.com/opencollective/opencollective-api/commit/0873b899) (2025-01-09) by Benjamin Piouffle
- **PR:** [#10612](https://github.com/opencollective/opencollective-api/pull/10612) - "perf(Transactions): add index for total donated (tiers)"
- **Used by:** GraphQL `Tier.stats.totalAmountReceived` -> `TierStats.totalAmountReceived` resolver ([`server/graphql/v2/object/TierStats.ts:17-31`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/TierStats.ts#L17-L31)) -> Tier totalDonated DataLoader ([`server/graphql/loaders/index.ts:898-923`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/loaders/index.ts#L898-L923)) -> joins Transactions to Orders via OrderId, filtering for CREDIT contributions/added_funds with no refunds, computing `SUM(netAmountInCollectiveCurrency)` per TierId.
- **EXPLAIN verified:** Yes (production, TierIds 1,2,3). Planner uses `Index Scan using transactions_total_donated` with `Index Cond: ("OrderId" = o.id)` in a Nested Loop with orders_tier_id. The partial WHERE clause pre-filters to only CREDIT contributions, making the join very efficient.

### transactions\_\_ContributorsQuery

- **Stats:** 47 MB, 3,486,244 entries, 312,623,962 scans (66 days)
- **Columns:** `CollectiveId`, `FromCollectiveId`, `UsingGiftCardFromCollectiveId`
- **Type:** CONCURRENT, partial
- **WHERE:** `type = 'CREDIT' AND kind NOT IN ('HOST_FEE', 'HOST_FEE_SHARE', 'HOST_FEE_SHARE_DEBT', 'PLATFORM_TIP_DEBT') AND deletedAt IS NULL AND RefundTransactionId IS NULL`
- **Migration:** [`migrations/20250409190000-add-transaction-contributors-query-index.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250409190000-add-transaction-contributors-query-index.js)
- **Commit:** [`515b2ccc`](https://github.com/opencollective/opencollective-api/commit/515b2ccc) (2025-04-10) by Leo Kewitz
- **PR:** [#10789](https://github.com/opencollective/opencollective-api/pull/10789) - "perf: add optimized index for ContributorsQuery"
- **Used by:** [`server/lib/contributors.ts:92-148`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/contributors.ts#L92-L148) -- the raw SQL `contributorsQuery` used by `getContributorsForCollective()`. The query joins Transactions on `CollectiveId = :collectiveId AND (FromCollectiveId = c.id OR UsingGiftCardFromCollectiveId = c.id)` with all the matching WHERE filters. Exposed via the GraphQL `contributors` field on `AccountWithContributions` ([`server/graphql/v2/interface/AccountWithContributions.ts`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/interface/AccountWithContributions.ts)), loaded through `req.loaders.Contributors.forCollectiveId` ([`server/graphql/loaders/contributors.ts`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/loaders/contributors.ts)).
- **EXPLAIN verified:** Yes (production, CollectiveId=11004). Planner uses `Bitmap Index Scan on "transactions__ContributorsQuery"` with `Index Cond: (("CollectiveId" = 11004) AND ("FromCollectiveId" = c.id))` as part of a BitmapOr with the UsingGiftCardFromCollectiveId index.

### UsingVirtualCardFromCollectiveId (renamed to transactions\_\_using_gift_card_from_collective_id)

- **Stats:** 109 MB, 11,746,103 entries, 106,952,175 scans (66 days)
- **Columns:** `UsingGiftCardFromCollectiveId` (column was renamed from `UsingVirtualCardFromCollectiveId`)
- **Type:** Simple B-tree (via Sequelize `addIndex`)
- **Migration:** [`migrations/archives/20190619155247-add-index-on-transactions-usingVirtualCardFromCollectiveId.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/archives/20190619155247-add-index-on-transactions-usingVirtualCardFromCollectiveId.js)
- **Commit:** [`7ed1b80b`](https://github.com/opencollective/opencollective-api/commit/7ed1b80b) (2019-06-19) by Benjamin Piouffle
- **PR:** none (direct commit)
- **Notes:** Index name in production is `transactions__using_gift_card_from_collective_id` (renamed when the column was renamed from VirtualCard to GiftCard).
- **Used by:** Same as `transactions__ContributorsQuery`: GraphQL `Account.contributors` field -> `req.loaders.Contributors.forCollectiveId` -> `contributorsQuery` ([`server/lib/contributors.ts:115`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/contributors.ts#L115)) which has `OR transactions."UsingGiftCardFromCollectiveId" = c.id`. Used as the second branch of the BitmapOr in the contributors query EXPLAIN plan.
- **Recommendation:** Replace with a partial index adding `WHERE deletedAt IS NULL`. Currently indexes all 11.7M rows with no partial filter. All queries go through Sequelize paranoid mode which always filters `deletedAt IS NULL`. A partial index would reduce size from ~109 MB to ~55 MB.
- **EXPLAIN verified:** Yes (seen in the ContributorsQuery EXPLAIN as `Bitmap Index Scan on transactions__using_gift_card_from_collective_id`).

### CollectiveId-FromCollectiveId-type

- **Stats:** 154 MB, 11,746,103 entries, 101,970,015 scans (66 days)
- **Columns:** `CollectiveId`, `FromCollectiveId`, `deletedAt`
- **Type:** Simple B-tree (via Sequelize `addIndex`)
- **Migration:** [`migrations/archives/201707140000-GroupToCollective.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/archives/201707140000-GroupToCollective.js)
- **Notes:** Despite the name suggesting "type", it actually indexes `deletedAt`.
- **Used by:** GraphQL v1 `Collective.members(orderBy: totalDonations)` -> `getMembersWithTotalDonations()` -> `buildTransactionsStatsQuery()` ([`server/lib/queries.js:575-580`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/queries.js#L575-L580), GROUP BY FromCollectiveId WHERE CollectiveId IN). Also: GraphQL v1 `Collective.backers` -> `getBackersStats()` ([`server/lib/hostlib.js:36-50`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/hostlib.js#L36-L50)).
- **Recommendation:** Long-term candidate for removal once v1 GraphQL API is fully deprecated. Largely superseded by `transactions__ContributorsQuery` for contributor lookups. The 102M scans suggest it still works well for smaller collectives where the planner avoids seq scan.
- **EXPLAIN verified:** No. For large collectives (CollectiveId=11004), the planner chooses Parallel Seq Scan. The index may help for smaller collectives but is largely superseded by more targeted indexes like `transactions__ContributorsQuery`.

### transactions\_\_order_id

- **Stats:** 113 MB, 11,074,618 entries, 66,757,738 scans (66 days)
- **Columns:** `OrderId`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND OrderId IS NOT NULL`
- **Migration:** [`migrations/20240126085540-transactions-index.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240126085540-transactions-index.js)
- **Commit:** [`b716ee0d`](https://github.com/opencollective/opencollective-api/commit/b716ee0d) (2024-02-01) by Francois Hodierne
- **PR:** [#9743](https://github.com/opencollective/opencollective-api/pull/9743) - "Transaction indexes"
- **Notes:** Replaced the original `DonationId` index from 2017.
- **Used by:** GraphQL `Account.transactions(order: "...")` -> `TransactionsCollectionQuery` resolver (`TransactionsCollectionQuery.ts:524-526`) adds `OrderId` filter. Also: `Transaction.byOrderId` DataLoader ([`server/graphql/loaders/index.ts:1148-1160`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/loaders/index.ts#L1148-L1160)) used by `Order.transactions` field. Also: GraphQL `account.stats.contributionsAmount` -> `AccountStats.contributionsAmount` resolver ([`server/graphql/v2/object/AccountStats.js:762`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/AccountStats.js#L762)) joins `Transactions t ON t."OrderId" = o.id`. Widely used in payment provider flows (Stripe/PayPal/Wise) for `Transaction.findAll({ where: { OrderId } })` after payment processing.
- **EXPLAIN verified:** Yes (production, OrderId=123456). Planner uses `Index Scan using transactions__order_id` with `Index Cond: ("OrderId" = 123456)`.

### transactions\_\_collective_id

- **Stats:** 120 MB, 11,635,299 entries, 50,612,397 scans (66 days)
- **Columns:** `CollectiveId`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL`
- **Migration:** [`migrations/20240126085540-transactions-index.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240126085540-transactions-index.js)
- **Commit:** [`b716ee0d`](https://github.com/opencollective/opencollective-api/commit/b716ee0d) (2024-02-01) by Francois Hodierne
- **PR:** [#9743](https://github.com/opencollective/opencollective-api/pull/9743) - "Transaction indexes"
- **Used by:** GraphQL `Host.hostStats.balance` -> `HostStats.balance` resolver -> `getTotalMoneyManagedAmount()` -> `sumCollectivesTransactions()` ([`server/lib/budget.js:808`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/budget.js#L808), core balance calculation, COUNT/SUM by CollectiveId). Also: cron [`cron/daily/20-onboarding.js:21`](https://github.com/opencollective/opencollective-api/blob/main/cron/daily/20-onboarding.js#L21) -> `onlyCollectivesWithoutTransactions()` (Transaction.count by CollectiveId). Also: payment processing flow -> `getBlockedContributionsCount()` ([`server/lib/budget.js:1037`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/budget.js#L1037), validates disputed contributions).
- **EXPLAIN verified:** Yes (production, CollectiveId=11004). Planner uses `Parallel Index Only Scan using transactions__collective_id` with `Index Cond: ("CollectiveId" = 11004)` for COUNT queries. This is an index-only scan (no heap access needed), making it very efficient for existence and count checks.

### transactions\_\_transaction_group

- **Stats:** 181 MB, 11,746,103 entries, 50,300,836 scans (66 days)
- **Columns:** `TransactionGroup`
- **Type:** BTREE
- **Notes:** Was planned in migration `20230327083410-transactions-indexes-non-null.js` but commented out. Created manually in production.
- **Used by:** Heavily used via multiple GraphQL entry points. (1) GraphQL `Transaction.relatedTransactions` field ([`server/graphql/v2/interface/Transaction.js:733-748`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/interface/Transaction.js#L733-L748)) -> `req.loaders.Transaction.relatedTransactions` DataLoader ([`server/graphql/loaders/transactions.ts:135-152`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/loaders/transactions.ts#L135-L152)) -> `Transaction.findAll({ where: { TransactionGroup } })`. (2) GraphQL `Transaction.netAmount` with `fetchHostFee`/`fetchPaymentProcessorFee`/`fetchTax` -> loaders at `transactions.ts:8-133` that query by `{ TransactionGroup, CollectiveId, kind }`. (3) GraphQL `transactionGroup` query ([`server/graphql/v2/query/TransactionGroupQuery.ts:35`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/query/TransactionGroupQuery.ts#L35)) -> direct `Transaction.findAll({ where: { TransactionGroup } })`.
- **Recommendation:** Formalize with migration and add `WHERE deletedAt IS NULL`. Currently indexes all 11.7M rows including soft-deleted. All queries use Sequelize paranoid mode which always filters `deletedAt IS NULL`. A partial index would reduce size from ~181 MB to ~90 MB.
- **EXPLAIN verified:** Yes (production, TransactionGroup UUID). Planner uses `Index Scan using transactions__transaction_group` with `Index Cond: ("TransactionGroup" = '...'::uuid)`. Typically returns 2-6 rows per group (DEBIT/CREDIT pairs with fees).

### transactions\_\_unrefunded_credits

- **Stats:** 188 MB, 5,721,527 entries, 35,561,309 scans (66 days)
- **Columns:** `CollectiveId`, `kind`, `createdAt`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND type = 'CREDIT' AND RefundTransactionId IS NULL`
- **Migration:** [`migrations/20250102080100-index-collective-page.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250102080100-index-collective-page.js)
- **Commit:** [`8538b1e2`](https://github.com/opencollective/opencollective-api/commit/8538b1e2) (2025-01-02) by Leo Kewitz
- **PR:** [#10603](https://github.com/opencollective/opencollective-api/pull/10603) - "Perf: Collective page indexes"
- **Used by:** GraphQL `account.stats.contributionsAmount` and `account.stats.contributionsAmountTimeSeries` fields. Trace: `AccountStats.contributionsAmount` resolver ([`server/graphql/v2/object/AccountStats.js:743-785`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/AccountStats.js#L743-L785)) -> inline `sequelize.query` joining Orders to Transactions with `t."deletedAt" IS NULL AND t."RefundTransactionId" IS NULL AND t."type" = 'CREDIT' AND t."kind" IN (:kinds)` where kinds = `['CONTRIBUTION', 'ADDED_FUNDS']` and CollectiveId comes from the account's order filter.
- **EXPLAIN verified:** Yes (production, CollectiveId=305 with kind IN). Planner uses `Index Scan using transactions__unrefunded_credits` with `Index Cond: (("CollectiveId" = 305) AND (kind = ANY ('{CONTRIBUTION,ADDED_FUNDS}')))`. Very efficient for per-collective contribution queries.

### CollectiveId-type (legacy)

- **Stats:** 129 MB, 11,746,103 entries, 23,338,851 scans (66 days)
- **Columns:** `CollectiveId`, `type`
- **Type:** Simple B-tree (via Sequelize `addIndex`)
- **Migration:** [`migrations/archives/201707140000-GroupToCollective.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/archives/201707140000-GroupToCollective.js)
- **Notes:** Legacy index from the Group-to-Collective rename migration.
- **Used by:** GraphQL `Account.stats.yearlyBudgetManaged` -> `AccountStats.yearlyBudgetManaged` resolver ([`server/graphql/v2/object/AccountStats.js:499-514`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/AccountStats.js#L499-L514)) -> `getTotalAnnualBudgetForHost()` ([`server/lib/queries.js:138-146`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/queries.js#L138-L146), SUM WHERE `type='CREDIT' AND CollectiveId IN ...`). Also used as a BitmapAnd companion with `transactions_kind` in EXPLAIN plans for `transactions(account: "...", type: CREDIT)` queries.
- **Recommendation:** Replace with a partial index adding `WHERE deletedAt IS NULL`. Legacy index from 2017 with no partial filter. All queries filter deleted rows via Sequelize paranoid mode. A partial index would reduce size from ~129 MB to ~64 MB. Long-term: may become droppable when v1 GraphQL API is fully deprecated.
- **EXPLAIN verified:** Yes (production, CollectiveId=11004). Planner uses `Bitmap Index Scan on "CollectiveId-type"` with `Index Cond: (("CollectiveId" = 11004) AND (type = 'CREDIT'))` as part of a BitmapAnd with `transactions_kind`.

### transactions\_\_collective_id_created_at_regular

- **Stats:** 466 MB, 11,635,299 entries, 14,802,313 scans (66 days)
- **Columns:** `CollectiveId`, `createdAt DESC`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL`
- **Migration:** [`migrations/20240202093411-transactions-index-2.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240202093411-transactions-index-2.js)
- **Commit:** [`26589263`](https://github.com/opencollective/opencollective-api/commit/26589263) (2024-02-06) by Francois Hodierne
- **PR:** [#9768](https://github.com/opencollective/opencollective-api/pull/9768) - "Transactions performance follow up"
- **Notes:** A "regular" createdAt-based alternative to the rounded-epoch version above.
- **Used by:** GraphQL v1 `Collective.transactions` field ([`server/graphql/v1/CollectiveInterface.js:1412`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v1/CollectiveInterface.js#L1412)) -> `collective.getTransactions()` ([`server/models/Collective.ts:3063-3127`](https://github.com/opencollective/opencollective-api/blob/main/server/models/Collective.ts#L3063-L3127), `ORDER BY createdAt DESC`) with raw createdAt (not ROUND expression). Also: GraphQL v1 `Collective.backers` field -> `getBackersStats()` ([`server/lib/hostlib.js:36`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/hostlib.js#L36)) which queries with `createdAt` date ranges; and [`server/graphql/common/features.ts:286`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/common/features.ts#L286) for feature flag checks (Transaction.count with CollectiveId + date range).
- **EXPLAIN verified:** Yes (production, CollectiveId=11004 with date range). Planner uses `Index Scan using transactions__collective_id_created_at_regular` with `Index Cond: (("CollectiveId" = 11004) AND ("createdAt" >= ...) AND ("createdAt" < ...))`. The planner prefers this over the rounded-epoch index when using raw createdAt comparisons.

### transactions\_\_collective_id_createdAt

- **Stats:** 427 MB, 11,635,299 entries, 13,552,581 scans (66 days)
- **Columns:** `CollectiveId`, `ROUND(EXTRACT(epoch FROM createdAt AT TIME ZONE 'UTC') / 10) DESC`
- **Type:** CONCURRENT, partial, expression-based
- **WHERE:** `deletedAt IS NULL`
- **Migration:** Originally in [`migrations/20240126085540-transactions-index.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240126085540-transactions-index.js), dropped and re-created in [`migrations/20250109150411-restore-invalid-transactions-indexes.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250109150411-restore-invalid-transactions-indexes.js)
- **Commit (re-creation):** [`d10450a9`](https://github.com/opencollective/opencollective-api/commit/d10450a9) (2025-01-09) by Benjamin Piouffle
- **PR (re-creation):** [#10621](https://github.com/opencollective/opencollective-api/pull/10621) - "fix(Transactions): re-create invalid indexes"
- **Commit (original):** [`b716ee0d`](https://github.com/opencollective/opencollective-api/commit/b716ee0d) (2024-02-01) by Francois Hodierne
- **PR (original):** [#9743](https://github.com/opencollective/opencollective-api/pull/9743) - "Transaction indexes"
- **Notes:** Uses rounded epoch seconds (10s buckets) instead of raw timestamps. Was re-created because the original became invalid.
- **Used by:** GraphQL `transactions(account: "...")` query -> `TransactionsCollectionQuery` resolver ([`server/graphql/v2/query/collection/TransactionsCollectionQuery.ts:360`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/query/collection/TransactionsCollectionQuery.ts#L360)) adds `CollectiveId` filter, and the ORDER BY at line 662 uses `LEDGER_ORDERED_TRANSACTIONS_FIELDS` map (line 61) with the exact same `ROUND(EXTRACT(epoch FROM ... / 10)` expression. Also: GraphQL v1 `Collective.transactions` field ([`server/graphql/v1/CollectiveInterface.js:1412`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v1/CollectiveInterface.js#L1412)) -> `collective.getTransactions()` ([`server/models/Collective.ts:3063-3127`](https://github.com/opencollective/opencollective-api/blob/main/server/models/Collective.ts#L3063-L3127), default `ORDER BY createdAt DESC`).
- **Recommendation:** Monitor v1 API deprecation. This ROUND epoch index (427 MB) and `transactions__collective_id_created_at_regular` (466 MB) serve different ordering patterns (ROUND epoch for v2 ledger ordering, raw createdAt for v1 and date range queries). If the v2 ledger ordering moves away from ROUND epoch, or v1 is sunset, one of these can be dropped, saving ~430 MB.
- **EXPLAIN verified:** Yes (production, CollectiveId=11004). Planner uses `Index Scan using "transactions__collective_id_createdAt"` with `Index Cond: ("CollectiveId" = 11004)`, returning rows already sorted. No separate sort step needed.

### transactions\_\_is_disputed

- **Stats:** 16 KB, 0 entries, 13,030,697 scans (66 days)
- **Columns:** `CollectiveId`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND isDisputed = true AND RefundTransactionId IS NULL`
- **Migration:** [`migrations/20221126080358-fast-balance.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20221126080358-fast-balance.js)
- **Commit:** [`9fcd85fa`](https://github.com/opencollective/opencollective-api/commit/9fcd85fa) (2022-12-12) by Francois Hodierne
- **PR:** [#8218](https://github.com/opencollective/opencollective-api/pull/8218) - "Fast Balances"
- **Used by:** GraphQL `Account.stats.balance` -> `AccountStats.balance` resolver -> `currentCollectiveBalance` DataLoader -> `CurrentCollectiveBalance` view lateral subquery ([`migrations/20230213080003-fast-balance-update.js:60-62,136-141`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20230213080003-fast-balance-update.js#L60-L62,136)) which sums `amountInHostCurrency` for disputed unreturned transactions (`isDisputed = true AND RefundTransactionId IS NULL`). Also: payment processing flow -> `getBlockedContributionsCount()` ([`server/lib/budget.js:1036-1046`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/budget.js#L1036-L1046)).
- **EXPLAIN verified:** Yes (production, CollectiveId=11004). Planner uses `Index Only Scan using transactions__is_disputed` with `Index Cond: ("CollectiveId" = 11004)`. Very efficient: only 56 estimated rows for OSC, index-only scan (no heap access).

### CurrentCollectiveTransactionStatsIndex

- **Stats:** 376 MB, 11,518,229 entries, 11,627,678 scans (66 days)
- **Columns:** `CollectiveId`, `createdAt`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND RefundTransactionId IS NULL AND (isRefund IS NOT TRUE OR kind = 'PAYMENT_PROCESSOR_COVER') AND isInternal IS NOT TRUE`
- **Migration:** [`migrations/20241230092547-current-collective-transaction-stats-indexes.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20241230092547-current-collective-transaction-stats-indexes.js)
- **Commit:** [`ebfbe30a`](https://github.com/opencollective/opencollective-api/commit/ebfbe30a) (2024-12-30) by Benjamin Piouffle
- **PR:** [#10589](https://github.com/opencollective/opencollective-api/pull/10589) - "perf: add index for current collective transaction stats"
- **Used by:** GraphQL `Account.stats.balance` -> `AccountStats.balance` resolver ([`server/graphql/v2/object/AccountStats.js:78-98`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/AccountStats.js#L78-L98)) -> `account.getBalanceAmount({ loaders })` -> `currentCollectiveBalance` DataLoader ([`server/graphql/loaders/index.ts:217-261`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/loaders/index.ts#L217-L261)) -> `CurrentCollectiveTransactionStats` view (defined in [`migrations/20240712081151-current-collective-views-update.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240712081151-current-collective-views-update.js)). The view's lateral subquery (lines 139-147) filters with all matching WHERE conditions. Also: `Host.hostStats.totalAmountSpent` -> `HostStats.totalAmountSpent` resolver ([`server/graphql/v2/object/HostStats.ts:50-66`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/HostStats.ts#L50-L66)) -> `getSumCollectivesAmountSpent()`; and `Host.hostStats.totalAmountReceived` -> `getSumCollectivesAmountReceived()`.
- **Recommendation:** Add `INCLUDE (amountInHostCurrency)` to enable index-only scans for balance calculations. The `CurrentCollectiveBalance` view's lateral subquery sums `amountInHostCurrency` which currently requires a heap lookup. With 11.6M scans in 66 days (~175K/day), even a small per-scan improvement would compound significantly.
- **EXPLAIN verified:** Yes (production, CollectiveId=11004). When querying the view directly or with matching WHERE conditions, planner uses `Bitmap Index Scan on "CurrentCollectiveTransactionStatsIndex"` with `Index Cond: (("CollectiveId" = 11004) AND ("createdAt" >= ...))`. Note: the view's lateral subquery actually uses `transactions__collective_id_createdAt` (the rounded-epoch index) because it matches the ROUND expression in the subquery; the `CurrentCollectiveTransactionStatsIndex` is used for direct queries with matching WHERE filters.

### txn_group_primary_testing

- **Stats:** 322 MB, 4,500,324 entries, 9,830,298 scans (66 days)
- **Columns:** `TransactionGroup`, `HostCollectiveId`, `createdAt` INCLUDE `(kind)`
- **Type:** BTREE, partial, covering (INCLUDE)
- **WHERE:** `deletedAt IS NULL AND kind IN ('EXPENSE', 'CONTRIBUTION', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD')`
- **Notes:** Created manually by Henrique during the host transactions report development (Slack thread, 2024-03-21). The "testing" suffix reflects its ad-hoc creation. No migration exists. A second index `txn_host_created_at_testing` was also created in the same session but no longer exists in production.
- **Used by:** GraphQL `Host.hostTransactionsReports` field ([`server/graphql/v2/object/Host.ts:253-448`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/Host.ts#L253-L448)). The resolver's `LEFT JOIN LATERAL` subquery finds the "primary" transaction in each group (one with kind IN EXPENSE, CONTRIBUTION, etc.) to compute `originKind` for secondary transactions (HOST_FEE, PLATFORM_TIP, etc.). This index speeds up that lateral join by filtering to only primary-kind rows per TransactionGroup. Also used during `HostMonthlyTransactions` materialized view refresh ([`cron/hourly/50-refresh-materialized-views.js`](https://github.com/opencollective/opencollective-api/blob/main/cron/hourly/50-refresh-materialized-views.js)). The 9.8M scans confirm heavy usage from the hourly refresh and dashboard queries. **Should be formalized with a migration** (remove "testing" suffix, or replace with a better-named index).
- **EXPLAIN verified:** Yes (production, TransactionGroup UUID + HostCollectiveId=9807). Planner uses `Index Scan using txn_group_primary_testing`. The partial WHERE pre-filters to primary-kind rows only, making the lateral join efficient.

### transactions\_\_non_debt

- **Stats:** 107 MB, 11,040,163 entries, 7,681,909 scans (66 days)
- **Columns:** `HostCollectiveId`, `CollectiveId`, `kind`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND isDebt = false`
- **Migration:** [`migrations/20250102080100-index-collective-page.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250102080100-index-collective-page.js)
- **Commit:** [`8538b1e2`](https://github.com/opencollective/opencollective-api/commit/8538b1e2) (2025-01-02) by Leo Kewitz
- **PR:** [#10603](https://github.com/opencollective/opencollective-api/pull/10603) - "Perf: Collective page indexes"
- **Used by:** GraphQL `transactions` collection query (`TransactionsCollectionQuery.ts:531-532`) adds `isDebt: false` when `includeDebts` is not set (the default). When combined with `host` arg (line 406: `HostCollectiveId`), `account` arg (line 360: `CollectiveId`), and `kind` arg (line 534-535), the generated WHERE matches all 3 indexed columns. This happens when querying e.g. `transactions(host: "...", account: "...", kind: CONTRIBUTION)`. However, for queries using only HostCollectiveId without CollectiveId or kind, the planner prefers other indexes.
- **EXPLAIN verified:** Yes (production, HostCollectiveId=9807, CollectiveId=305, kind='CONTRIBUTION'). Planner uses `Index Scan using transactions__non_debt` with `Index Cond: (("HostCollectiveId" = 9807) AND ("CollectiveId" = 305) AND (kind = 'CONTRIBUTION'))`. For broader queries (HostCollectiveId only), the planner prefers BitmapAnd with `transactions__host_collective_id` + `CollectiveId-type`.

### transactions\_\_expense_payment_date

- **Stats:** 7 MB, 230,616 entries, 3,140,808 scans (66 days)
- **Columns:** `ExpenseId`, `COALESCE(clearedAt, createdAt)`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND type = 'DEBIT' AND kind = 'EXPENSE' AND isRefund = false AND RefundTransactionId IS NULL`
- **Migration:** [`migrations/20260116133511-add-expense-payment-date-index.ts`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20260116133511-add-expense-payment-date-index.ts)
- **Commit:** [`5e275003`](https://github.com/opencollective/opencollective-api/commit/5e275003) (2026-01-20) by Gustav Larsson
- **PR:** [#11333](https://github.com/opencollective/opencollective-api/pull/11333) - "feat(Expenses): Add paidAt and ability to sort on paidAt to ExpensesCollectionQuery"
- **Used by:** GraphQL `expenses(orderBy: {field: PAID_AT})` -> `ExpensesCollectionQuery` paidAt sorting subquery ([`server/graphql/v2/query/collection/ExpensesCollectionQuery.ts:720-736`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/query/collection/ExpensesCollectionQuery.ts#L720-L736)): `SELECT COALESCE(t."clearedAt", t."createdAt") FROM "Transactions" t WHERE t."ExpenseId" = "Expense"."id" AND t."type" = 'DEBIT' AND t."kind" = 'EXPENSE' AND t."isRefund" = false`. Also: GraphQL `Expense.paidAt` field resolver ([`server/graphql/v2/object/Expense.ts:288-304`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/Expense.ts#L288-L304)).
- **EXPLAIN verified:** Yes (production, ExpenseId=123456). Planner uses `Index Scan using transactions__expense_payment_date` with `Index Cond: ("ExpenseId" = 123456)`. Very efficient: 1 estimated row per expense.

### transactions_expense_id

- **Stats:** 12 MB, 558,332 entries, 2,563,823 scans (66 days)
- **Columns:** `ExpenseId`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND ExpenseId IS NOT NULL`
- **Migration:** [`migrations/archives/20211102144237-add-multiple-indexes.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/archives/20211102144237-add-multiple-indexes.js)
- **Commit:** [`0b576087`](https://github.com/opencollective/opencollective-api/commit/0b576087) (2021-11-02) by Benjamin Piouffle
- **PR:** [#6776](https://github.com/opencollective/opencollective-api/pull/6776) - "perf: Add some indexes on Transactions & Orders"
- **Used by:** GraphQL v2 `Expense.transaction` field -> `Transaction.byExpenseId` DataLoader ([`server/graphql/loaders/index.ts:1155-1160`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/loaders/index.ts#L1155-L1160)) -> `Transaction.findAll({ where: { ExpenseId: { [Op.in]: keys } } })`. Also: GraphQL v1 `Expense.transaction` field ([`server/graphql/v1/types.js:874-880`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v1/types.js#L874-L880)) -> `Transaction.findOne({ where: { ExpenseId, type: 'DEBIT' } })`. Widely used in expense payment/refund mutations (`payExpense`, `markExpenseAsUnpaid`) via `Transaction.findAll({ where: { ExpenseId } })`.
- **EXPLAIN verified:** Yes (production, ExpenseId=123456). Planner uses `Index Scan using transactions_expense_id` with `Index Cond: ("ExpenseId" = 123456)`. Very efficient: ~18 estimated rows per expense.

### transactions_expenses_tags_index

- **Stats:** 2 MB, 230,616 entries, 715,458 scans (66 days)
- **Columns:** `CollectiveId`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND RefundTransactionId IS NULL AND kind = 'EXPENSE' AND type = 'DEBIT' AND ExpenseId IS NOT NULL`
- **Migration:** [`migrations/20250106103603-transactions-expenses-tags-indexes.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250106103603-transactions-expenses-tags-indexes.js)
- **Commit:** [`0a823a63`](https://github.com/opencollective/opencollective-api/commit/0a823a63) (2025-01-06) by Benjamin Piouffle
- **PR:** [#10611](https://github.com/opencollective/opencollective-api/pull/10611) - "perf(Budget): add index for transactions expenses tags"
- **Used by:** GraphQL `expenses(account: "...", orderBy: {field: PAID_AT})` -> `ExpensesCollectionQuery` paidAt ordering subquery ([`server/graphql/v2/query/collection/ExpensesCollectionQuery.ts:725-735`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/query/collection/ExpensesCollectionQuery.ts#L725-L735)) which joins to Transactions filtered by kind='EXPENSE', type='DEBIT'. Also: expense stats DataLoaders in [`server/graphql/loaders/index.ts:782-835`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/loaders/index.ts#L782-L835) for tag-based budget breakdowns. Note: the `transactions(tags: ...)` GraphQL argument was declared but never implemented (deprecated since 2020-08-09).
- **EXPLAIN verified:** Yes (production, CollectiveId=11004). Planner uses `Bitmap Index Scan on transactions_expenses_tags_index` with `Index Cond: ("CollectiveId" = 11004)` when filtering by CollectiveId with matching WHERE conditions and joining to Expenses for tags.

### transactions_kind

- **Stats:** 108 MB, 11,635,299 entries, 361,531 scans (66 days)
- **Columns:** `kind`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL`
- **Migration:** [`migrations/archives/20211102144237-add-multiple-indexes.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/archives/20211102144237-add-multiple-indexes.js)
- **Commit:** [`0b576087`](https://github.com/opencollective/opencollective-api/commit/0b576087) (2021-11-02) by Benjamin Piouffle
- **PR:** [#6776](https://github.com/opencollective/opencollective-api/pull/6776) - "perf: Add some indexes on Transactions & Orders"
- **Used by:** Used as a BitmapAnd companion with other indexes. Seen in EXPLAIN plans for GraphQL `transactions(account: "...", kind: CONTRIBUTION)` -> `TransactionsCollectionQuery` (line 534-535 adds `kind` filter), where the planner combines `Bitmap Index Scan on "CollectiveId-type"` with `Bitmap Index Scan on transactions_kind`. Also: payment processing flow -> `getBlockedContributionsCount()` ([`server/lib/budget.js:1036`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/budget.js#L1036), with `kind: 'CONTRIBUTION'`). Low selectivity (few distinct kind values), only useful combined with other indexes or for index-only count scans.
- **EXPLAIN verified:** Yes (production, kind='CONTRIBUTION'). Planner uses `Parallel Index Only Scan using transactions_kind` with `Index Cond: (kind = 'CONTRIBUTION')`. Efficient for count queries as index-only scan avoids heap access.

### transactions_uuid

- **Stats:** 540 MB, 11,746,103 entries, 89,715 scans (66 days)
- **Columns:** `uuid`, `deletedAt`
- **Type:** UNIQUE
- **Migration:** Originally [`migrations/archives/20170220000000-transactions-add-uuid.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/archives/20170220000000-transactions-add-uuid.js), updated in [`migrations/archives/201807060000-fixLedger.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/archives/201807060000-fixLedger.js)
- **Notes:** Unique constraint on UUID + deletedAt for soft-delete compatibility.
- **Used by:** GraphQL `transaction(id: "...")` query -> `TransactionQuery` resolver ([`server/graphql/v2/query/TransactionQuery.ts:27`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/query/TransactionQuery.ts#L27)) -> `models.Transaction.findOne({ where: { uuid: args.id } })`. Also: `TransactionReferenceInput` ([`server/graphql/v2/input/TransactionReferenceInput.ts:30`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/input/TransactionReferenceInput.ts#L30)) used by mutations that take a transaction reference. Core lookup path for all single-transaction fetches by public ID.
- **EXPLAIN verified:** Yes (production, uuid + deletedAt IS NULL). Planner uses `Index Scan using transactions_uuid` with `Index Cond: ((uuid = '...'::uuid) AND ("deletedAt" IS NULL))`. Returns at most 1 row (unique index).

### Transactions_HostCollectiveId_CollectiveId

- **Stats:** 474 MB, 11,635,299 entries, 65,786 scans (66 days)
- **Columns:** `HostCollectiveId`, `createdAt` INCLUDE `(CollectiveId)`
- **Type:** CONCURRENT, partial, covering (INCLUDE)
- **WHERE:** `deletedAt IS NULL`
- **Migration:** [`migrations/20250828121802-add-subscription-utilization-indexes.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250828121802-add-subscription-utilization-indexes.js)
- **Commit:** [`23bb2e78`](https://github.com/opencollective/opencollective-api/commit/23bb2e78) (2025-08-29) by Henrique
- **PR:** [#11068](https://github.com/opencollective/opencollective-api/pull/11068) - "Add missing indexes"
- **Used by:** GraphQL `Host.fundingMethod` field ([`server/graphql/v2/object/Host.ts:630-676`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/Host.ts#L630-L676)) -> raw SQL with `WHERE t."HostCollectiveId" = :id` and `GROUP BY DATE_TRUNC(:timeUnit, COALESCE(t."clearedAt", t."createdAt"))`. Also: GraphQL `CommunityStats.transactionSummary` ([`server/graphql/v2/object/CommunityStats.ts:103-127`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/CommunityStats.ts#L103-L127)) -> raw SQL with `WHERE t."HostCollectiveId" = :id AND t."CollectiveId" = :id`. For queries matching the CREDIT contribution WHERE clause, the planner prefers `Transactions_HostCollectiveId_Contributions` (more selective). This index serves broader queries that don't match those conditions.
- **EXPLAIN verified:** Yes (production, HostCollectiveId=11004). Planner uses `Index Only Scan using "Transactions_HostCollectiveId_Contributions"` for the time-series query. The covering INCLUDE columns allow index-only access without heap lookups.
- **Notes:** For queries that match the partial WHERE (CREDIT contributions, not refunded), the planner prefers `Transactions_HostCollectiveId_Contributions` over this index since it's more selective. This index serves broader queries that don't match those conditions.

### transactions\_\_host_collective_id_createdAt

- **Stats:** 287 MB, 8,173,722 entries, 65,069 scans (66 days)
- **Columns:** `HostCollectiveId`, `ROUND(EXTRACT(epoch FROM createdAt AT TIME ZONE 'UTC') / 10) DESC`
- **Type:** CONCURRENT, partial, expression-based
- **WHERE:** `deletedAt IS NULL AND HostCollectiveId IS NOT NULL`
- **Migration:** [`migrations/20250109150411-restore-invalid-transactions-indexes.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250109150411-restore-invalid-transactions-indexes.js)
- **Commit:** [`d10450a9`](https://github.com/opencollective/opencollective-api/commit/d10450a9) (2025-01-09) by Benjamin Piouffle
- **PR:** [#10621](https://github.com/opencollective/opencollective-api/pull/10621) - "fix(Transactions): re-create invalid indexes"
- **Notes:** Companion to `transactions__collective_id_createdAt`, same rounded-epoch approach. Also re-created due to invalidity.
- **Used by:** GraphQL `transactions(host: "...")` query -> `TransactionsCollectionQuery` resolver ([`server/graphql/v2/query/collection/TransactionsCollectionQuery.ts:406`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/query/collection/TransactionsCollectionQuery.ts#L406)) adds `HostCollectiveId` filter, ORDER BY uses same ROUND expression. Also: GraphQL `Host.hostMetricsTimeSeries.platformTips` -> `HostMetricsTimeSeries` resolver ([`server/graphql/v2/object/HostMetricsTimeSeries.ts:40-47`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/HostMetricsTimeSeries.ts#L40-L47)) -> `getPlatformTips()` ([`server/lib/host-metrics.js:92`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/host-metrics.js#L92)); and `Host.hostMetricsTimeSeries.hostFees` -> `getHostFeesTimeSeries()` (line 218). Both filter `WHERE HostCollectiveId = :id AND createdAt >= :startDate`.
- **Recommendation:** Same overlap situation as the CollectiveId pair. This ROUND epoch index (287 MB) and `transactions__host_collective_id_created_at_regular` (442 MB) could be consolidated if one ordering pattern is retired. Potential saving: ~287 MB.
- **EXPLAIN verified:** Yes (production, HostCollectiveId=11004). Planner uses `Index Scan using "transactions__host_collective_id_createdAt"` with `Index Cond: ("HostCollectiveId" = 11004)`, returning rows already sorted. No separate sort step needed.

### transactions\_\_host_collective_id

- **Stats:** 74 MB, 8,173,722 entries, 42,389 scans (66 days)
- **Columns:** `HostCollectiveId`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND HostCollectiveId IS NOT NULL`
- **Migration:** [`migrations/20240126085540-transactions-index.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240126085540-transactions-index.js)
- **Commit:** [`b716ee0d`](https://github.com/opencollective/opencollective-api/commit/b716ee0d) (2024-02-01) by Francois Hodierne
- **PR:** [#9743](https://github.com/opencollective/opencollective-api/pull/9743) - "Transaction indexes"
- **Notes:** Replaced the earlier `transaction_host_collective_id` (singular) from PR [#7496](https://github.com/opencollective/opencollective-api/pull/7496).
- **Used by:** GraphQL `Host.hostStats.balance` -> `HostStats.balance` resolver ([`server/graphql/v2/object/HostStats.ts:37-48`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/HostStats.ts#L37-L48)) -> `host.getTotalMoneyManaged()` -> `getTotalMoneyManagedAmount()` ([`server/lib/budget.js:571`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/budget.js#L571)) which aggregates by HostCollectiveId. Also: GraphQL `deletePayoutMethod` mutation -> `payoutMethod.canBeDeleted()` -> checks Transaction.count by HostCollectiveId ([`server/lib/collectivelib.ts:442-456`](https://github.com/opencollective/opencollective-api/blob/main/server/lib/collectivelib.ts#L442-L456)).
- **EXPLAIN verified:** Yes (production, HostCollectiveId=9807). Planner uses `Bitmap Index Scan on transactions__host_collective_id` with `Index Cond: ("HostCollectiveId" = 9807)` as part of a BitmapAnd with a type filter. For large hosts like 11004 (OSC), the planner may prefer a Parallel Seq Scan when the result set is very large.

### transactions\_\_data_paypal_capture_id

- **Stats:** 24 MB, 670,703 entries, 25,350 scans (66 days)
- **Columns:** `(data#>>'{paypalCaptureId}') ASC` (JSONB expression)
- **Type:** BTREE, CONCURRENT, partial
- **WHERE:** `data#>>'{paypalCaptureId}' IS NOT NULL AND deletedAt IS NULL`
- **Migration:** [`migrations/20230131115800-index-paypal-transaction-id.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20230131115800-index-paypal-transaction-id.js)
- **Commit:** [`48d7809e`](https://github.com/opencollective/opencollective-api/commit/48d7809e) (2023-01-31) by Benjamin Piouffle
- **PR:** [#8489](https://github.com/opencollective/opencollective-api/pull/8489) - "PayPal unified & indexed charge ID"
- **Notes:** Migration also consolidates PayPal capture/sale/transaction IDs into a unified `data.paypalCaptureId` field before creating the index.
- **Used by:** PayPal webhook `PAYMENT.CAPTURE.COMPLETED` -> `handleCaptureCompleted()` ([`server/paymentProviders/paypal/webhook.ts:162`](https://github.com/opencollective/opencollective-api/blob/main/server/paymentProviders/paypal/webhook.ts#L162)) -> `findTransactionByPaypalId()` ([`server/paymentProviders/paypal/payment.ts:145-150`](https://github.com/opencollective/opencollective-api/blob/main/server/paymentProviders/paypal/payment.ts#L145-L150)). Also: cron [`cron/daily/51-synchronize-paypal-ledger.ts:71-86`](https://github.com/opencollective/opencollective-api/blob/main/cron/daily/51-synchronize-paypal-ledger.ts#L71-L86) (raw SQL: `WHERE t."data" #>> '{paypalCaptureId}' = :paypalId`).
- **EXPLAIN verified:** Yes (production). Planner uses `Bitmap Index Scan on transactions__data_paypal_capture_id` with `Index Cond: ((data #>> '{paypalCaptureId}') = ...)`.

### transactions\_\_host_collective_id_created_at_regular

- **Stats:** 442 MB, 11,635,299 entries, 19,373 scans (66 days)
- **Columns:** `HostCollectiveId`, `createdAt DESC`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL`
- **Migration:** [`migrations/20240325093342-create-host-monthly-transactions-materialized-view.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240325093342-create-host-monthly-transactions-materialized-view.js)
- **Commit:** [`651d8a87`](https://github.com/opencollective/opencollective-api/commit/651d8a87) (2024-04-03) by Gustav Larsson
- **PR:** [#9944](https://github.com/opencollective/opencollective-api/pull/9944) - "Host Transactions Reports View"
- **Notes:** HostCollectiveId companion to `transactions__collective_id_created_at_regular`.
- **Used by:** `HostMonthlyTransactions` materialized view (auto-refreshed, [`migrations/20240325093342-create-host-monthly-transactions-materialized-view.js:6-49`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240325093342-create-host-monthly-transactions-materialized-view.js#L6-L49)) which groups by `DATE_TRUNC(month, createdAt)` and `HostCollectiveId`. Also: GraphQL `transactions(host: "...", dateFrom: ..., dateTo: ...)` -> `TransactionsCollectionQuery` resolver (line 406 adds `HostCollectiveId`, lines 482-493 add `createdAt` range).
- **EXPLAIN verified:** Yes (production, HostCollectiveId=9807 with date range). Planner uses `Index Scan using transactions__host_collective_id_created_at_regular` with `Index Cond: (("HostCollectiveId" = 9807) AND ("createdAt" >= ...) AND ("createdAt" < ...))`. For very large hosts like OSC (11004), the planner may prefer Seq Scan when fetching a full year of data.

### transactions\_\_contributions_fromcollective_to_host

- **Stats:** 165 MB, 3,902,056 entries, 16,473 scans (66 days)
- **Columns:** `HostCollectiveId`, `FromCollectiveId`, `createdAt`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND kind = 'CONTRIBUTION' AND RefundTransactionId IS NULL`
- **Migration:** [`migrations/20250123143500-index-transactions-fromCollective-hostCollective.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20250123143500-index-transactions-fromCollective-hostCollective.js)
- **Commit:** [`194dda02`](https://github.com/opencollective/opencollective-api/commit/194dda02) (2025-02-07) by Leo Kewitz
- **PR:** [#10661](https://github.com/opencollective/opencollective-api/pull/10661) - "ContributionFlow: Information requirement resolvers"
- **Used by:** [`server/graphql/loaders/contributors.ts:35-44`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/loaders/contributors.ts#L35-L44) -- the `generateTotalContributedToHost` DataLoader. Raw SQL query filtering `FromCollectiveId IN (:CollectiveIds) AND HostCollectiveId = :HostId AND createdAt >= :since` with `kind IN ('CONTRIBUTION', 'ADDED_FUNDS')`. Exposed via the `totalContributedToHost` field on `ContributorProfile` ([`server/graphql/v2/object/ContributorProfile.ts`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/ContributorProfile.ts)).
- **EXPLAIN verified:** Partially. The actual loader query uses `kind IN ('CONTRIBUTION', 'ADDED_FUNDS')` and `FromCollectiveId IN (...)` which prevents full index usage (planner chooses Parallel Seq Scan for the combined query). However, when the query is narrowed to `kind = 'CONTRIBUTION'` with a single `FromCollectiveId`, the planner uses `Bitmap Index Scan on transactions__contributions_fromcollective_to_host` with `Index Cond: (("HostCollectiveId" = 11004) AND ("FromCollectiveId" = 11004) AND ("createdAt" >= ...))`. The index partially helps with the CONTRIBUTION portion of the OR expansion.

### transactions\_\_stripe_charge_id

- **Stats:** 141 MB, 3,229,396 entries, 10,659 scans (66 days)
- **Columns:** `(data#>>'{charge,id}') DESC` (JSONB expression)
- **Type:** BTREE, CONCURRENT, partial
- **WHERE:** `data#>>'{charge,id}' IS NOT NULL`
- **Migration:** [`migrations/20221012165909-add-stripe-charge-id-index.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20221012165909-add-stripe-charge-id-index.js)
- **Commit:** [`c56a358d`](https://github.com/opencollective/opencollective-api/commit/c56a358d) (2022-10-21) by jv
- **PR:** [#8029](https://github.com/opencollective/opencollective-api/pull/8029) - "feat(stripe-dispute-orders): Create webhooks for new and closed disputes"
- **Used by:** Stripe webhooks `payment_intent.succeeded` -> `handleOrderPaymentIntentSucceeded()` ([`server/paymentProviders/stripe/webhook.ts:226`](https://github.com/opencollective/opencollective-api/blob/main/server/paymentProviders/stripe/webhook.ts#L226)) and `handleExpensePaymentIntentSucceeded()` (line 300); `charge.dispute.created` -> `chargeDisputeCreated()` (line 617); `charge.dispute.closed` -> `chargeDisputeClosed()` (line 700). All do `Transaction.findOne({ where: { data: { charge: { id } } } })`.
- **EXPLAIN verified:** Yes (production). Planner uses `Index Scan using transactions__stripe_charge_id` with `Index Cond: ((data #>> '{charge,id}') = ...)`.

### transactions\_\_collective_clearedAt

- **Stats:** 260 MB, 11,635,299 entries, 10,274 scans (66 days)
- **Columns:** `CollectiveId`, `clearedAt DESC`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL`
- **Migration:** [`migrations/20240212114556-add-transaction-cleared-at.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240212114556-add-transaction-cleared-at.js)
- **Commit:** [`f42cfb4e`](https://github.com/opencollective/opencollective-api/commit/f42cfb4e) (2024-02-21) by Leo Kewitz
- **PR:** [#9829](https://github.com/opencollective/opencollective-api/pull/9829) - "Implement Transaction.clearedAt"
- **Used by:** GraphQL `transactions(account: "...", clearedFrom: ..., clearedTo: ...)` -> `TransactionsCollectionQuery` resolver (lines 503-508) adds `clearedAt` range filter with CollectiveId. Note: the `orderBy: {field: clearedAt}` case at line 662-686 uses `COALESCE(clearedAt, createdAt)`, NOT raw clearedAt, so this index is only used for the range filter, not for ordering.
- **Recommendation:** Evaluate if `clearedFrom`/`clearedTo` filter args are used in practice. With only 10K scans for 260 MB, this may not justify its cost. The `COALESCE(clearedAt, createdAt)` ordering in TransactionsCollectionQuery does NOT use this index (it uses the COALESCE-based covering indexes instead). If the raw clearedAt range filter is rarely needed, consider dropping.
- **EXPLAIN verified:** Yes (production, CollectiveId=11004, ORDER BY clearedAt DESC LIMIT 50). Planner uses `Index Scan using "transactions__collective_clearedAt"` with `Index Cond: ("CollectiveId" = 11004)`. Note: queries using `COALESCE(clearedAt, createdAt)` ordering will NOT use this index.

### Transactions_Orders_by_date

- **Stats:** 95 MB, 1,996,838 entries, 8,489 scans (66 days)
- **Columns:** `COALESCE(clearedAt, createdAt)` INCLUDE `(OrderId, isDebt, isRefund, kind, CollectiveId, HostCollectiveId, FromCollectiveId)`
- **Type:** CONCURRENT, partial, covering (INCLUDE)
- **WHERE:** `kind IN ('CONTRIBUTION', 'ADDED_FUNDS') AND deletedAt IS NULL AND type = 'CREDIT'`
- **Migration:** [`migrations/20260223145153-add-transaction-orders-by-date-index.ts`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20260223145153-add-transaction-orders-by-date-index.ts)
- **Commit:** [`d777e176`](https://github.com/opencollective/opencollective-api/commit/d777e176) (2026-02-24) by Henrique
- **PR:** [#11437](https://github.com/opencollective/opencollective-api/pull/11437) - "Orders resolver with kysely query builder"
- **Used by:** GraphQL `orders(chargedDateFrom: ..., chargedDateTo: ...)` query -> `OrdersCollectionQuery` Kysely resolver ([`server/graphql/v2/query/collection/OrdersCollectionQuery.ts:711-745`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/query/collection/OrdersCollectionQuery.ts#L711-L745)) -> subquery filtering DISTINCT ON OrderId by `COALESCE(clearedAt, createdAt)` date range for contributions, without a host filter. The INCLUDE columns enable index-only access.
- **EXPLAIN verified:** Yes (production, date range 2025). Planner uses `Index Scan using "Transactions_Orders_by_date"` with `Index Cond: ((COALESCE("clearedAt", "createdAt") >= ...) AND (COALESCE("clearedAt", "createdAt") <= ...))`.

### transactions\_\_payment_method_id

- **Stats:** 70 MB, 6,662,390 entries, 2,573 scans (66 days)
- **Columns:** `PaymentMethodId`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL AND PaymentMethodId IS NOT NULL`
- **Migration:** [`migrations/20240126085540-transactions-index.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240126085540-transactions-index.js)
- **Commit:** [`b716ee0d`](https://github.com/opencollective/opencollective-api/commit/b716ee0d) (2024-02-01) by Francois Hodierne
- **PR:** [#9743](https://github.com/opencollective/opencollective-api/pull/9743) - "Transaction indexes"
- **Notes:** Replaced the earlier `PaymentMethodId-type` composite index from 2018.
- **Used by:** GraphQL v1 `PaymentMethod.balance` field ([`server/graphql/v1/types.js:1689-1695`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v1/types.js#L1689-L1695)) -> `paymentMethod.getBalanceForUser()` -> `giftcard.getBalance()` ([`server/paymentProviders/opencollective/giftcard.js:32-72`](https://github.com/opencollective/opencollective-api/blob/main/server/paymentProviders/opencollective/giftcard.js#L32-L72)) -> `Transaction.findAll({ where: { PaymentMethodId, type: 'DEBIT', RefundTransactionId: null } })`. Also triggered during `addFunds` mutation -> `executeOrder()` -> `giftcard.processOrder()` -> `getBalance()`. Also: GraphQL v1 `PaymentMethod.fromCollectives` field ([`server/graphql/v1/types.js:1750-1775`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v1/types.js#L1750-L1775)) -> `Transaction.findAll({ where: { PaymentMethodId } })` for DISTINCT FromCollectiveId.
- **EXPLAIN verified:** Yes (production, PaymentMethodId=12345). Planner uses `Index Scan using transactions__payment_method_id` with `Index Cond: ("PaymentMethodId" = 12345)`.

### transactions\_\_hostCollective_clearedAt

- **Stats:** 197 MB, 11,635,299 entries, 199 scans (66 days)
- **Columns:** `HostCollectiveId`, `clearedAt DESC`
- **Type:** CONCURRENT, partial
- **WHERE:** `deletedAt IS NULL`
- **Migration:** [`migrations/20240212114556-add-transaction-cleared-at.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20240212114556-add-transaction-cleared-at.js)
- **Commit:** [`f42cfb4e`](https://github.com/opencollective/opencollective-api/commit/f42cfb4e) (2024-02-21) by Leo Kewitz
- **PR:** [#9829](https://github.com/opencollective/opencollective-api/pull/9829) - "Implement Transaction.clearedAt"
- **Used by:** GraphQL `transactions(host: "...", clearedFrom: ..., clearedTo: ...)` -> `TransactionsCollectionQuery` resolver (lines 503-508) adds `clearedAt` range filter with HostCollectiveId. Same as the collective version: only for range filtering, not ordering (ordering uses COALESCE). Note: `Host.fundingMethod` ([`server/graphql/v2/object/Host.ts:630-676`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/Host.ts#L630-L676)) uses `COALESCE(clearedAt, createdAt)`, not raw clearedAt, so the planner prefers `Transactions_HostCollectiveId_Contributions` for that query.
- **Recommendation:** Strong candidate for removal. Only 199 scans for 197 MB (~1 MB per scan). Same issue as the collective version: COALESCE-based ordering does not use this index. All COALESCE queries prefer `Transactions_HostCollectiveId_Contributions`. If the raw `clearedFrom`/`clearedTo` + host filter is confirmed unused by any dashboard or API consumer, drop it.
- **EXPLAIN verified:** Indirectly. For COALESCE-based queries, the planner prefers `Transactions_HostCollectiveId_Contributions`. This index is only used for raw `clearedAt` range queries with a HostCollectiveId filter (the `clearedFrom`/`clearedTo` args in TransactionsCollectionQuery).

### transactions\_\_stripe_charge_payment_intent

- **Stats:** 133 MB, 3,008,177 entries, 47 scans (66 days)
- **Columns:** `(data#>>'{charge,payment_intent}') DESC` (JSONB expression)
- **Type:** BTREE, CONCURRENT, partial
- **WHERE:** `data#>>'{charge,payment_intent}' IS NOT NULL`
- **Migration:** [`migrations/20221026185532-add-stripe-charge-payment-intent-index.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20221026185532-add-stripe-charge-payment-intent-index.js)
- **Commit:** [`c56a358d`](https://github.com/opencollective/opencollective-api/commit/c56a358d) (2022-10-21) by jv
- **PR:** [#8029](https://github.com/opencollective/opencollective-api/pull/8029) - "feat(stripe-dispute-orders): Create webhooks for new and closed disputes"
- **Used by:** Stripe webhooks `review.opened` -> `reviewOpened()` ([`server/paymentProviders/stripe/webhook.ts:874`](https://github.com/opencollective/opencollective-api/blob/main/server/paymentProviders/stripe/webhook.ts#L874)) and `review.closed` -> `reviewClosed()` (line 955). Both do `Transaction.findOne({ where: { data: { charge: { payment_intent } } } })`.
- **EXPLAIN verified:** Yes (production). Planner uses `Index Scan using transactions__stripe_charge_payment_intent` with `Index Cond: ((data #>> '{charge,payment_intent}') = ...)`.

### Transactions_HostCollectiveId_Contributions

- **Stats:** 146 MB, 1,992,507 entries, 25 scans (66 days)
- **Columns:** `HostCollectiveId`, `COALESCE(clearedAt, createdAt)` INCLUDE `(OrderId, CollectiveId, FromCollectiveId, createdAt, clearedAt, amountInHostCurrency, currency)`
- **Type:** CONCURRENT, partial, covering (INCLUDE)
- **WHERE:** `NOT isRefund AND RefundTransactionId IS NULL AND type = 'CREDIT' AND deletedAt IS NULL AND kind IN ('CONTRIBUTION', 'ADDED_FUNDS')`
- **Migration:** [`migrations/20260224141315-add-transaction-host-orders-by-date-index.ts`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20260224141315-add-transaction-host-orders-by-date-index.ts)
- **Commit:** [`2421d200`](https://github.com/opencollective/opencollective-api/commit/2421d200) (2026-02-24) by Henrique
- **PR:** [#11455](https://github.com/opencollective/opencollective-api/pull/11455) - "Add index for orders report, add deletedAt filter"
- **Used by:** GraphQL `orders(host: "...", chargedDateFrom: ..., chargedDateTo: ...)` query -> `OrdersCollectionQuery` Kysely resolver ([`server/graphql/v2/query/collection/OrdersCollectionQuery.ts:711-745`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/query/collection/OrdersCollectionQuery.ts#L711-L745)) -> subquery filtering DISTINCT ON OrderId WHERE `HostCollectiveId` AND `COALESCE(clearedAt, createdAt)` date range. Also: GraphQL `Host.fundingMethod` field ([`server/graphql/v2/object/Host.ts:630-676`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/Host.ts#L630-L676)) -> raw SQL with same HostCollectiveId + COALESCE pattern.
- **EXPLAIN verified:** Yes (production, HostCollectiveId=11004 with date range). Planner uses `Index Only Scan using "Transactions_HostCollectiveId_Contributions"` with `Index Cond: (("HostCollectiveId" = 11004) AND (COALESCE("clearedAt", "createdAt") >= ...) AND (COALESCE("clearedAt", "createdAt") <= ...))`. The covering INCLUDE columns make this an index-only scan.

### transactions\_\_data\_\_dispute_id

- **Stats:** 96 MB, 3,133 entries, 19 scans (66 days)
- **Columns:** `(data#>>'{dispute,id}')` (JSONB expression)
- **Type:** HASH, CONCURRENT, partial
- **WHERE:** `data#>>'{dispute,id}' IS NOT NULL AND deletedAt IS NULL`
- **Migration:** [`migrations/20221207135000-index-transaction-dispute-id.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/20221207135000-index-transaction-dispute-id.js)
- **Commit:** [`cdf56b03`](https://github.com/opencollective/opencollective-api/commit/cdf56b03) (2022-12-07) by Leo Kewitz
- **PR:** [#8269](https://github.com/opencollective/opencollective-api/pull/8269) - "Fix Stripe charge.dispute.closed webhook handler"
- **Used by:** Stripe webhook `charge.dispute.closed` -> `chargeDisputeClosed()` ([`server/paymentProviders/stripe/webhook.ts:728`](https://github.com/opencollective/opencollective-api/blob/main/server/paymentProviders/stripe/webhook.ts#L728)) -> `Transaction.findOne({ where: { data: { dispute: { id: dispute.id } } } })`.
- **EXPLAIN verified:** Yes (production). Planner uses `Bitmap Index Scan on transactions__data__dispute_id` with `Index Cond: ((data #>> '{dispute,id}') = ...)`.

### transaction_wise_transfer_id

- **Stats:** 10 MB, 248,235 entries, 0 scans (66 days)
- **Columns:** `(data#>>'{transfer,id}') DESC` (JSONB expression)
- **Type:** BTREE, CONCURRENT, partial
- **WHERE:** `data#>>'{transfer,id}' IS NOT NULL`
- **Migration:** [`migrations/archives/20220405130000-optimize-transaction-wise-index-.js`](https://github.com/opencollective/opencollective-api/blob/main/migrations/archives/20220405130000-optimize-transaction-wise-index-.js)
- **Commit:** [`e7591a20`](https://github.com/opencollective/opencollective-api/commit/e7591a20) (2022-04-05) by Leo Kewitz
- **PR:** [#7379](https://github.com/opencollective/opencollective-api/pull/7379) - "fix: drop existing index in favor of an optimized one"
- **Notes:** Replaced the earlier `transferwise_transfer_id` index with an optimized BTREE version.
- **Used by:** Wise webhook `transfer state change` -> `handleTransferStateChange()` ([`server/paymentProviders/transferwise/webhook.ts:67-72`](https://github.com/opencollective/opencollective-api/blob/main/server/paymentProviders/transferwise/webhook.ts#L67-L72)) -> `Transaction.findOne({ where: { ExpenseId, data: { transfer: { id } } } })`. Also: refund handler (line 142-151) and cron [`cron/daily/91-check-pending-transferwise-transactions.ts`](https://github.com/opencollective/opencollective-api/blob/main/cron/daily/91-check-pending-transferwise-transactions.ts).
- **EXPLAIN verified:** Yes (production). Planner uses `Bitmap Index Scan on transaction_wise_transfer_id` with `Index Cond: ((data #>> '{transfer,id}') = ...)`.

### transactions\_\_created_by_user_id

- **Stats:** 117 MB, 11,746,103 entries, 11,096 scans (66 days)
- **Columns:** `CreatedByUserId`
- **Type:** BTREE
- **Notes:** Was planned in migration `20230327083410-transactions-indexes-non-null.js` but commented out as "not looking useful". Created manually in production. Also commented out in migration `20240126085540`.
- **Used by:** Stripe webhook handlers via Sequelize association JOIN. Three handlers in [`server/paymentProviders/stripe/webhook.ts`](https://github.com/opencollective/opencollective-api/blob/main/server/paymentProviders/stripe/webhook.ts) use `Transaction.findOne({ include: [{ model: User, required: true, as: 'createdByUser' }] })`, which generates `INNER JOIN "Users" ON "Transactions"."CreatedByUserId" = "Users"."id"`. (1) `chargeDisputeCreated()` (line 614): `charge.dispute.created` webhook, fetches user to limit their ORDER feature. (2) `chargeDisputeClosed()` (line 697): `charge.dispute.closed` webhook, checks if user has other disputes. (3) `reviewClosed()` (line 948): `review.closed` webhook, fraud review handling. ~167 scans/day matches typical Stripe dispute/review volume. The association is defined in [`server/models/index.ts:317`](https://github.com/opencollective/opencollective-api/blob/main/server/models/index.ts#L317): `Transaction.belongsTo(User, { foreignKey: 'CreatedByUserId', as: 'createdByUser' })`.
- **Recommendation:** If kept, replace with `WHERE deletedAt IS NULL AND CreatedByUserId IS NOT NULL`. Currently indexes all 11.7M rows for only ~167 scans/day. A partial index would reduce size from ~117 MB to ~58 MB. Alternatively, the Stripe webhook queries could be rewritten to JOIN Users directly by primary key, removing the need for this index entirely.
- **EXPLAIN verified:** Yes (production, CreatedByUserId=12345). Planner uses `Index Scan using transactions__created_by_user_id` with `Index Cond: ("CreatedByUserId" = 12345)`. Used via JOIN, not direct WHERE clause. Note: the index is 117 MB (all 11.7M rows) for only ~167 scans/day. A `WHERE CreatedByUserId IS NOT NULL` partial index would be smaller, but the savings may not justify a migration. **Low value relative to size, but actively used.**

### transactions\_\_contributions_date

- **Stats:** 60 MB, 1,976,087 entries, 36 scans (66 days)
- **Columns:** `COALESCE(clearedAt, createdAt)` INCLUDE `(OrderId, HostCollectiveId)`
- **Type:** BTREE, partial, covering (INCLUDE)
- **WHERE:** `kind IN ('CONTRIBUTION', 'ADDED_FUNDS') AND type = 'CREDIT' AND isRefund = false AND RefundTransactionId IS NULL AND deletedAt IS NULL`
- **Notes:** Created manually before the migration-based `Transactions_Orders_by_date`. Same indexed expression but fewer INCLUDE columns.
- **Used by:** GraphQL `account.stats.contributionsAmountTimeSeries` field ([`server/graphql/v2/object/AccountStats.js:800-830`](https://github.com/opencollective/opencollective-api/blob/main/server/graphql/v2/object/AccountStats.js#L800-L830)) -> inline `sequelize.query` ordering by `COALESCE(t."clearedAt", t."createdAt")` with matching WHERE filters. However, the planner may prefer `Transactions_Orders_by_date` which has broader INCLUDE columns.
- **EXPLAIN verified:** Yes (production, global ORDER BY COALESCE(clearedAt, createdAt) DESC LIMIT 100). Planner uses `Index Scan Backward using transactions__contributions_date`.
- **Redundancy note:** Largely superseded by `Transactions_Orders_by_date` (migration `20260223145153`), which has broader INCLUDE columns (adds isDebt, isRefund, kind, CollectiveId, FromCollectiveId). **Candidate for removal.**

### transactions\_\_contributions_host_id

- **Stats:** 78 MB, 1,976,087 entries, 12 scans (66 days)
- **Columns:** `HostCollectiveId`, `COALESCE(clearedAt, createdAt)` INCLUDE `(OrderId)`
- **Type:** BTREE, partial, covering (INCLUDE)
- **WHERE:** `kind IN ('CONTRIBUTION', 'ADDED_FUNDS') AND type = 'CREDIT' AND isRefund = false AND RefundTransactionId IS NULL AND deletedAt IS NULL`
- **Notes:** Created manually before the migration-based `Transactions_HostCollectiveId_Contributions`. Same indexed columns but only INCLUDE (OrderId) vs 7 columns.
- **Used by:** No unique code path. All queries matching this index (e.g. GraphQL `orders` collection with `chargedDateFrom`/`chargedDateTo` + host filter in `OrdersCollectionQuery.ts:711-745`) also match `Transactions_HostCollectiveId_Contributions`, which the planner always prefers.
- **EXPLAIN verified:** Superseded. For the same query pattern (HostCollectiveId=9807, ORDER BY COALESCE(clearedAt, createdAt) DESC), the planner always chooses `Transactions_HostCollectiveId_Contributions` (broader INCLUDE enables index-only scans). **Candidate for removal.**

**Total indexes in production: 38** (excluding `Transactions_pkey`).

## Dropped/Replaced Indexes

| Index Name                                    | Columns                                | Created                                                                                                                                                                     | Dropped By                                                                        | Notes                                                |
| --------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `DonationId`                                  | `DonationId` (now `OrderId`)           | 2017-07-12 ([`fef2ab93`](https://github.com/opencollective/opencollective-api/commit/fef2ab93))                                                                             | PR [#9743](https://github.com/opencollective/opencollective-api/pull/9743) (2024) | Replaced by `transactions__order_id`                 |
| `PaymentMethodId-type`                        | `PaymentMethodId`, `type`, `deletedAt` | 2018-11-21 ([`4e1dac52`](https://github.com/opencollective/opencollective-api/commit/4e1dac52))                                                                             | PR [#9743](https://github.com/opencollective/opencollective-api/pull/9743) (2024) | Replaced by `transactions__payment_method_id`        |
| `transferwise_transfer_id`                    | `(data -> 'transfer' ->> 'id')`        | 2021-05-07 ([`e0a9ff68`](https://github.com/opencollective/opencollective-api/commit/e0a9ff68))                                                                             | PR [#7379](https://github.com/opencollective/opencollective-api/pull/7379) (2022) | Replaced by `transaction_wise_transfer_id`           |
| `transaction_host_collective_id`              | `HostCollectiveId`                     | 2022-05-05 ([`ae190b5e`](https://github.com/opencollective/opencollective-api/commit/ae190b5e), PR [#7496](https://github.com/opencollective/opencollective-api/pull/7496)) | PR [#9743](https://github.com/opencollective/opencollective-api/pull/9743) (2024) | Replaced by `transactions__host_collective_id`       |
| `Transactions_GroupId`                        | unknown                                | unknown                                                                                                                                                                     | PR [#9743](https://github.com/opencollective/opencollective-api/pull/9743) (2024) | Dropped in the migration, no creation found          |
| `transactions__collective_id_sorted`          | `CollectiveId`, `id ASC`               | 2022-12-12 (PR [#8218](https://github.com/opencollective/opencollective-api/pull/8218))                                                                                     | PR [#9743](https://github.com/opencollective/opencollective-api/pull/9743) (2024) | Confirmed dropped, does not exist in production      |
| `transactions__collective_id_created_at_type` | unknown                                | unknown                                                                                                                                                                     | PR [#9743](https://github.com/opencollective/opencollective-api/pull/9743) (2024) | Dropped in the migration, no creation found          |
| `privacy_transfer_id`                         | `(data ->> 'token')`                   | 2021-06-15                                                                                                                                                                  | unknown                                                                           | Does not exist in production, Privacy.com deprecated |

## Timeline

| Date       | Index                                                                                 | Action                                        | PR                                                                        |
| ---------- | ------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| 2017-07-12 | `DonationId`                                                                          | Created                                       | (no PR)                                                                   |
| 2018-11-21 | `PaymentMethodId-type`                                                                | Created                                       | (no PR)                                                                   |
| 2019-06-19 | `UsingVirtualCardFromCollectiveId`                                                    | Created                                       | (no PR)                                                                   |
| 2021-05-07 | `transferwise_transfer_id`                                                            | Created                                       | (no PR)                                                                   |
| 2021-06-15 | `privacy_transfer_id`                                                                 | Created                                       | (no PR)                                                                   |
| 2021-11-02 | `transactions_kind`, `transactions_expense_id`                                        | Created                                       | [#6776](https://github.com/opencollective/opencollective-api/pull/6776)   |
| 2022-04-05 | `transaction_wise_transfer_id`                                                        | Created (replaces `transferwise_transfer_id`) | [#7379](https://github.com/opencollective/opencollective-api/pull/7379)   |
| 2022-05-05 | `transaction_host_collective_id`                                                      | Created                                       | [#7496](https://github.com/opencollective/opencollective-api/pull/7496)   |
| 2022-10-21 | `transactions__stripe_charge_id`, `transactions__stripe_charge_payment_intent`        | Created                                       | [#8029](https://github.com/opencollective/opencollective-api/pull/8029)   |
| 2022-12-07 | `transactions__data__dispute_id`                                                      | Created                                       | [#8269](https://github.com/opencollective/opencollective-api/pull/8269)   |
| 2022-12-12 | `transactions__collective_id_sorted`, `transactions__is_disputed`                     | Created                                       | [#8218](https://github.com/opencollective/opencollective-api/pull/8218)   |
| 2023-01-31 | `transactions__data_paypal_capture_id`                                                | Created                                       | [#8489](https://github.com/opencollective/opencollective-api/pull/8489)   |
| 2024-02-01 | 5 new indexes, 4+ dropped                                                             | Major overhaul                                | [#9743](https://github.com/opencollective/opencollective-api/pull/9743)   |
| 2024-02-06 | `transactions__collective_id_created_at_regular`                                      | Created                                       | [#9768](https://github.com/opencollective/opencollective-api/pull/9768)   |
| 2024-12-30 | `CurrentCollectiveTransactionStatsIndex`                                              | Created                                       | [#10589](https://github.com/opencollective/opencollective-api/pull/10589) |
| 2025-01-06 | `transactions_expenses_tags_index`                                                    | Created                                       | [#10611](https://github.com/opencollective/opencollective-api/pull/10611) |
| 2025-01-09 | `transactions__collective_id_createdAt`, `transactions__host_collective_id_createdAt` | Re-created (fixed)                            | [#10621](https://github.com/opencollective/opencollective-api/pull/10621) |
| 2025-02-07 | `transactions__contributions_fromcollective_to_host`                                  | Created                                       | [#10661](https://github.com/opencollective/opencollective-api/pull/10661) |
| 2025-04-10 | `transactions__ContributorsQuery`                                                     | Created                                       | [#10789](https://github.com/opencollective/opencollective-api/pull/10789) |
| 2025-08-29 | `Transactions_HostCollectiveId_CollectiveId`                                          | Created                                       | [#11068](https://github.com/opencollective/opencollective-api/pull/11068) |
| 2026-01-20 | `transactions__expense_payment_date`                                                  | Created                                       | [#11333](https://github.com/opencollective/opencollective-api/pull/11333) |
| 2026-02-23 | `Transactions_Orders_by_date`                                                         | Created                                       | [#11437](https://github.com/opencollective/opencollective-api/pull/11437) |
| 2026-02-24 | `Transactions_HostCollectiveId_Contributions`                                         | Created                                       | [#11455](https://github.com/opencollective/opencollective-api/pull/11455) |

## Conclusion

The Transactions table carries 39 indexes totaling 6.6 GB, which is 155% of the table's own 4.2 GB data size. This is a significant overhead for writes (every INSERT, UPDATE, or DELETE must update all 39 indexes) and for storage.

The analysis traced every index to its real entry point (GraphQL field, webhook, cron, or mutation) and verified each against production EXPLAIN plans. The findings fall into four categories:

**Actively used and well-justified (26 indexes).** These are confirmed used by real production code paths and the PostgreSQL planner selects them. Top performers by scan count include `transactions_total_donated` (741M scans, only 25 MB), `transactions__ContributorsQuery` (312M scans), `transactions__using_gift_card_from_collective_id` (107M scans), `transactions__order_id` (67M scans), and `transactions__collective_id` (51M scans).

**Used but with low or declining value (5 indexes).** These have confirmed code paths but show signs of low utility:

- `transactions__hostCollective_clearedAt` (197 MB, 199 scans): Only used for raw `clearedAt` range queries with host filter. Most host queries use COALESCE(clearedAt, createdAt) instead, which this index does not support.
- `transactions__stripe_charge_payment_intent` (133 MB, 47 scans): Only triggered by Stripe `review.opened`/`review.closed` webhooks, which are rare events.
- `transaction_wise_transfer_id` (10 MB, 0 scans): Wise webhook and cron triggered, but zero scans in 66 days suggests the cron may be disabled or Wise volume is negligible.
- `transactions__contributions_fromcollective_to_host` (165 MB, 16K scans): Partially effective because the actual loader query uses `kind IN ('CONTRIBUTION', 'ADDED_FUNDS')` but the index only covers `kind = 'CONTRIBUTION'`.
- `transactions__payment_method_id` (70 MB, 2,573 scans): Only used by gift card balance checks and a legacy v1 field.

**Superseded by newer indexes (2 indexes, 138 MB reclaimable):**

- `transactions__contributions_date` (60 MB, 36 scans): Superseded by `Transactions_Orders_by_date` which has the same indexed expression but broader INCLUDE columns.
- `transactions__contributions_host_id` (78 MB, 12 scans): Superseded by `Transactions_HostCollectiveId_Contributions` which has the same indexed columns but broader INCLUDE columns.

**Low value relative to size (1 index, 117 MB):**

- `transactions__created_by_user_id` (117 MB, 11K scans): Used by Stripe webhook handlers (`charge.dispute.created`, `charge.dispute.closed`, `review.closed`) via Sequelize association INNER JOIN on `CreatedByUserId`. Only ~167 scans/day for 117 MB. A partial index or relying on the Users primary key JOIN may be sufficient.

**Untracked but actively used (2 indexes, need formalization):**

- `txn_group_primary_testing` (322 MB, 9.8M scans): Created manually by Henrique during host transactions report development. Used by the `Host.hostTransactionsReports` resolver's lateral join and the `HostMonthlyTransactions` materialized view refresh. Should be formalized with a migration and renamed.
- `transactions__transaction_group` (181 MB, 50M scans): Core index for all TransactionGroup lookups. Should be formalized with a migration.

**Untracked indexes (5 indexes).** Five production indexes have no migration: `transactions__created_by_user_id`, `transactions__transaction_group`, `transactions__contributions_date`, `transactions__contributions_host_id`, and `txn_group_primary_testing`. Of these, `transactions__transaction_group` (50M scans) and `txn_group_primary_testing` (9.8M scans) are actively used and should be formalized.

## Follow-up Actions

### Immediate: drop superseded indexes (138 MB savings)

Create a migration to drop these 2 indexes. They are fully superseded by newer indexes with broader INCLUDE columns. Combined savings: 138 MB.

```sql
DROP INDEX CONCURRENTLY IF EXISTS "transactions__contributions_date";       -- 60 MB, superseded by Transactions_Orders_by_date
DROP INDEX CONCURRENTLY IF EXISTS "transactions__contributions_host_id";    -- 78 MB, superseded by Transactions_HostCollectiveId_Contributions
```

### Short-term: formalize txn_group_primary_testing (322 MB)

Created manually by Henrique during host transactions report development. Used by `Host.hostTransactionsReports` lateral join and `HostMonthlyTransactions` materialized view refresh. Create a migration to:

1. Rename to something like `transactions__transaction_group_primary_kind` to reflect its purpose
2. Consider whether the current column set (`TransactionGroup`, `HostCollectiveId`, `createdAt` INCLUDE `kind`) is optimal, or if it could be simplified now that the feature is stable

### Short-term: investigate low-value indexes

These indexes have confirmed code paths but very low usage relative to their size. Evaluate whether the code paths are still needed or could be rewritten:

1. **`transactions__hostCollective_clearedAt`** (197 MB, 199 scans): Check if any user actually queries transactions with `clearedFrom`/`clearedTo` args + host filter. If not, drop it.
2. **`transactions__stripe_charge_payment_intent`** (133 MB, 47 scans): Stripe reviews are rare. Consider whether the 133 MB cost is justified for handling a few reviews per month. The query could fall back to a seq scan on the small result set from `transactions__stripe_charge_id`.
3. **`transaction_wise_transfer_id`** (10 MB, 0 scans): Verify if the Wise pending transactions cron ([`cron/daily/91-check-pending-transferwise-transactions.ts`](https://github.com/opencollective/opencollective-api/blob/main/cron/daily/91-check-pending-transferwise-transactions.ts)) is still active. If Wise volume is negligible, this is low priority given its small size.

### Short-term: formalize the untracked index

`transactions__transaction_group` is heavily used (50M scans) but has no migration. Create a migration to formalize it:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__transaction_group"
  ON "Transactions" ("TransactionGroup")
  WHERE "deletedAt" IS NULL;
```

Adding the `WHERE deletedAt IS NULL` partial filter would reduce its size from 181 MB (currently indexes all 11.7M rows including soft-deleted) while still serving all existing queries.

### Medium-term: review index overlap

Several index groups cover similar query patterns with different trade-offs:

1. **CollectiveId ordering indexes**: `transactions__collective_id_createdAt` (ROUND epoch, 427 MB), `transactions__collective_id_created_at_regular` (raw createdAt, 466 MB), and `transactions__collective_clearedAt` (clearedAt, 260 MB) all index CollectiveId with a date column. Evaluate whether all three orderings are needed.
2. **HostCollectiveId ordering indexes**: Similarly, `transactions__host_collective_id_createdAt` (287 MB), `transactions__host_collective_id_created_at_regular` (442 MB), `transactions__hostCollective_clearedAt` (197 MB), and `Transactions_HostCollectiveId_Contributions` (146 MB) overlap. The newest covering index may subsume some of the older ones for contribution queries.
3. **Legacy v1 indexes**: `CollectiveId-type` (129 MB) and `CollectiveId-FromCollectiveId-type` (154 MB) are from 2017 and serve mostly v1 GraphQL fields. As v1 is deprecated, these may become droppable.

### Medium-term: address write amplification

Every transaction INSERT must update all 39 indexes. With the table receiving continuous writes (contributions, expenses, tips), this amplification affects write throughput. The immediate drops (4 indexes) reduce this from 39 to 35. Further consolidation from the overlap review could bring it to around 30, meaningfully improving write performance.
