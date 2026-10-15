# PostgreSQL search: benchmark and deployment plan

Status: **team preview only.** OpenSearch is the default search backend and keeps its synchronization and
infrastructure. Team members opt in to the PostgreSQL backend per user (preview feature `SEARCH_POSTGRES_BACKEND`), and
every request can use `backend: OPENSEARCH` again. Public launch, switching the default, and retiring OpenSearch are
out of scope (spec: opencollective/opencollective#8935, this work: #8944).

**Every number below comes from synthetic data on a single benchmark machine.** No production measurement has been
made yet. Use these numbers to compare designs and to size risk, not as production response times. See
[Missing production evidence](#missing-production-evidence).

## Known differences with OpenSearch

- Updates: host administrators only find the published (public or private) Updates of their hosted Accounts, never
  drafts (same rule as `canSeeUpdate`). OpenSearch still lets them match drafts (`OpenSearchUpdatesAdapter`, unchanged).

## Reproduce the benchmark

The benchmark runs the real provider code (`PostgresProvider.search`: adapters, ranked statement, budget, concurrency
caps, planner pre-check) against `PG_URL`. Two scripts:

- `scripts/search/postgres-search-benchmark-dataset.ts`: deterministic, production-shaped synthetic data in the real
  schema (see the file header for the distributions; `--scale` resizes everything).
- `scripts/search/postgres-search-benchmark.ts`: phases `info`, `matrix`, `explain`, `concurrency`, `writes` (see the
  file header). Default cases use the synthetic vocabulary. Against another database (for example a restored
  production snapshot), pass `--cases <file.json>` with terms that exist there.

```bash
# A disposable PostgreSQL 16 with explicit resources (never run the dataset script on a real database)
docker run -d --name oc-search-bench --cpus=4 --memory=16g --shm-size=4g -p 5464:5432 \
  -e POSTGRES_USER=opencollective -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=oc_search_bench postgres:16 \
  -c shared_buffers=4GB -c effective_cache_size=12GB -c maintenance_work_mem=1GB -c max_connections=200 \
  -c max_wal_size=8GB -c track_io_timing=on -c random_page_cost=1.1 -c log_min_duration_statement=2000
docker exec oc-search-bench psql -U opencollective -d postgres -c 'CREATE ROLE postgres SUPERUSER LOGIN'
export PG_URL=postgres://opencollective@127.0.0.1:5464/oc_search_bench

# Real schema, without the search migrations yet (so that their build is measured on the loaded tables)
PGPORT=5464 ./scripts/db_restore.sh -d oc_search_bench -h 127.0.0.1
npm run db:migrate -- --to 20261006120000-payout-method-connected-account.ts
npm run script scripts/search/postgres-search-benchmark-dataset.ts -- --url $PG_URL   # ~25 min here
npm run db:migrate                                                                     # search migrations (timed)

# Results (JSON with --out; one plan file per case with --explain-dir)
PG_MAX_CONNECTIONS=50 npm run script scripts/search/postgres-search-benchmark.ts -- \
  --phase info,matrix,explain,writes --explain-dir /tmp/plans --out /tmp/bench.json
PG_MAX_CONNECTIONS=50 npm run script scripts/search/postgres-search-benchmark.ts -- \
  --phase concurrency --users 1,8,32 --duration 60 --with-writes
```

Cold-cache numbers: restart the container and drop the OS page cache (`sync; echo 3 | sudo tee
/proc/sys/vm/drop_caches`) before each case, then run it with `--grep`.

## Environment of the recorded run (2026-10-15)

|                     |                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code                | API `Postgres-search` + this branch (`pgsearch-8944`), frontend `pgsearch-8944`                                                                                                                                                                                          |
| Machine             | 8 vCPU / 44 GB VM, Docker volume on a virtio disk. PostgreSQL container limited to **4 CPUs and 16 GB** (page cache included), nothing else running                                                                                                                      |
| PostgreSQL          | 16.15. `shared_buffers` 4GB, `effective_cache_size` 12GB, `work_mem` 4MB, `maintenance_work_mem` 1GB, `random_page_cost` 1.1, `max_parallel_workers_per_gather` 2, `jit` on, `effective_io_concurrency` 1, `default_statistics_target` 100, `gin_pending_list_limit` 4MB |
| Search transactions | `work_mem` 32MB, `jit` off, `max_parallel_workers_per_gather` 0, `effective_io_concurrency` ≥ 64, `statement_timeout` = remaining budget (10 s default)                                                                                                                  |
| Extensions          | `unaccent` 1.1, `pg_trgm` 1.6, `btree_gin` 1.3 (schema `public`)                                                                                                                                                                                                         |
| API process         | Pool max 50 (`PG_MAX_CONNECTIONS`, as production), 8 concurrent search statements per process, 2 per request                                                                                                                                                             |

Dataset (27 GB with indexes). Only the Accounts and Transactions sizes come from production; the others are guesses.

| Table                              | Rows                                             | Heap            | Notes                                                                                                    |
| ---------------------------------- | ------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------- |
| Collectives                        | 1.15M (1.05M undeleted; 116k deleted or private) | 1.0 GB          | 3,000 hosts, largest host has 24k active accounts                                                        |
| Transactions                       | 12.97M                                           | 4.7 GB          | Double-entry groups, templated descriptions ("Financial contribution to …", "Host Fee", "Platform Tip"…) |
| Orders / Subscriptions             | 4.0M / 640k                                      | 1.5 GB          | 80% templated descriptions                                                                               |
| Expenses / ExpenseItems            | 1.0M / 2.0M                                      | 390 / 334 MB    | Currency/status words in the text                                                                        |
| Comments                           | 1.5M                                             | 643 MB          | HTML, 8-68 words                                                                                         |
| Updates / Tiers / HostApplications | 100k / 300k / 150k                               | 90 / 98 / 62 MB | 40% default tier names                                                                                   |

## Index build (deployment rehearsal) and storage

`npm run db:migrate` on the loaded tables (concurrent builds, quiet database): **4 min 40 s in total**.

| Migration                                             | Duration | Largest indexes (build time, size)                                                                      |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| Normalization (functions, text search configurations) | < 0.1 s  |                                                                                                         |
| Collectives                                           | 33 s     | `collectives_pg_search_public` 18 s / 69 MB                                                             |
| Updates                                               | 25 s     | `updates_pg_search_text` 19 s / 61 MB; `ANALYZE "Updates"` 3.8 s                                        |
| Orders                                                | 25 s     | `orders_pg_search_description` 15 s / 52 MB, `_label` 10 s / 87 MB                                      |
| Tiers, Host Applications, Collectives helpers         | 15 s     | each < 6 s, < 30 MB                                                                                     |
| Expenses + items                                      | 22 s     | `expenses_pg_search_restricted` 8 s / 32 MB                                                             |
| Transactions                                          | 97 s     | `_collective_description` 48 s / 216 MB, `_host_description` 41 s / 119 MB, `_merchant_id` 7 s / 195 MB |
| Comments                                              | 67 s     | `comments_pg_search_text` 65 s / 261 MB                                                                 |

All search indexes together: **~1.4 GB** (5% of the dataset). No table rewrite, no new column, no backfill.

Write overhead (single-row inserts copied from existing rows, inside rolled-back transactions, warmed up and
interleaved, 500 rows each, quiet database):

| Table                           | p50 without → with search indexes | p95 without → with |
| ------------------------------- | --------------------------------- | ------------------ |
| Transactions (3 search indexes) | 599 → 631 µs                      | 767 → 799 µs       |
| Orders (2)                      | 410 → 443 µs                      | 652 → 662 µs       |
| Comments (3)                    | 262 → 324 µs                      | 343 → 397 µs       |
| Expenses (5)                    | 316 → 391 µs                      | 375 → 477 µs       |
| Updates (3)                     | 285 → 485 µs                      | 429 → 631 µs       |

GIN indexes use the pending list (`fastupdate`): its flush (every ~4 MB of entries, or by autovacuum) is paid by the
insert that triggers it. It showed up as 115 KB of WAL per row in the Updates run. Under the concurrency benchmark
below, a concurrent Transactions writer stayed at p50 4-8 ms and p95 5-57 ms (the p95 rises with CPU saturation, not
with index maintenance).

## Results

### Single searches (warm cache, median of 3, final code)

Root unless noted. "Rejected" = visible `SearchTooBroad` error from the planner pre-check, in 2-4 ms.

| Entity            | Broad term (matches): time                                                                                        | Common term                                 | Selective term | Host scope (largest host)                   | Account scope (busiest account) |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------- | ------------------------------------------- | ------------------------------- |
| Accounts          | `co` 21k: 40 ms; `foundation` 13k: 37 ms (deep page 49 ms)                                                        | `open source` 9 ms; typo `foundatoin` 39 ms | 3 ms           | 17-44 ms                                    | 3-4 ms                          |
| Updates           | `foundation` 34k: 44 ms                                                                                           | 30 ms                                       | 3 ms           | 3-27 ms                                     | 39-40 ms                        |
| Tiers             | `sponsor` 30k: 61 ms                                                                                              | `gold sponsor` 42 ms                        | 2 ms           | 2-46 ms                                     | 2-3 ms                          |
| Host applications | `community` 16k: 20 ms                                                                                            | 7 ms                                        | 2 ms           | 2-5 ms                                      | 1-2 ms                          |
| Comments          | `studio` 145k: 606 ms; `water` 146k: 566 ms                                                                       | `water studio` 93 ms                        | 7 ms           | 13-605 ms                                   | 4-140 ms                        |
| Expenses          | `usd` 531k: 1.06 s; `paid` 331k: 618 ms; `travel` 98k: 354 ms                                                     | `travel hotel` 24 ms                        | 4 ms           | 10-449 ms                                   | 4-273 ms                        |
| Orders            | `financial contribution` 2.8M: 2.7 s; `monthly` 708k: 696 ms                                                      | `backer` 87 ms                              | 2 ms           | 3 ms-1.25 s                                 | 3-49 ms                         |
| Transactions      | `invoice` 248k: 828 ms; `fee` 4.5M, `host fee` 2.3M, `financial contribution` 3.0M, `platform tip` 1.2M: rejected |                                             | 8 ms           | `fee` 451k: 1.27 s; `host fee` 229k: 1.16 s | 14-59 ms                        |

Other roles cost at most the same as root, ±40%: anonymous users skip the restricted arms (Expenses `usd`: 0.59 s
vs 1.06 s for root), administrators add restricted arms on their domain (Updates `foundation`: 59 ms vs 44 ms), and
non-root roles only search their own domain for Comments and Host applications. Deep pages (offset 5000) cost the same as the first page:
the cost is the size of the match set. Planning time: p50 0.7 ms, p95 2.4 ms, max 5 ms (pre-check: one more planning).

Cold cache (PostgreSQL restarted, OS cache dropped), final code: Orders `financial contribution` 6.7 s, Transactions
host `fee` 6.7 s, Transactions `invoice` 4.8 s, Comments `studio` 3.7 s, Expenses `usd` 1.4 s, Updates
`foundation` 0.48 s, Accounts `co` 0.34 s, Tiers `sponsor` 0.23 s.

Plans (all 219 cases saved by `--explain-dir`): no sequential scan on Collectives, Transactions, Orders, Expenses or
Comments. Lossy bitmaps and `HashAggregate` spills to disk (up to 60 MB) only happen with millions of matches: the
Transactions searches that the pre-check rejects, and unscoped Orders template words.

### Concurrency (frontend-like load)

Each virtual user loops on command-menu requests (all 8 entities, limit 5) with common and selective terms, as root,
host administrator or collective administrator, some host-scoped; a `SELECT 1` canary on the same pool every 100 ms
and a single-row Transactions writer every 20 ms. One API process (8 search statements at a time).

| Users                   | Requests/s (×8 entity searches) | Request p50 / p95 / p99  | Waiting for a search slot (avg / max) | Pool waits | `SELECT 1` canary p95 / p99 | Insert p50 / p95 |
| ----------------------- | ------------------------------- | ------------------------ | ------------------------------------- | ---------- | --------------------------- | ---------------- |
| 1                       | 5.4                             | 93 ms / 887 ms / 1.45 s  | 0                                     | 0          | 1 / 1 ms                    | 4 / 5 ms         |
| 8                       | 14.3                            | 314 ms / 1.83 s / 2.87 s | 5.5 / 8                               | 0          | 3 / 51 ms                   | 8 / 56 ms        |
| 32                      | 13.5                            | 2.17 s / 3.91 s / 4.98 s | 52 / 56                               | 0          | 4 / 51 ms                   | 8 / 57 ms        |
| 8, broad terms included | 8.3                             | 806 ms / 2.0 s / 2.8 s   | 5.5 / 8                               | 0          | 4 / 53 ms                   | 8 / 57 ms        |

- The database (4 vCPU) is CPU-bound from ~8 concurrent statements. The per-process cap queues the rest in the API
  process: the shared pool (50) never waited and unrelated queries kept their latency. With several web dynos, the
  database sees up to 8 search statements per dyno.
- Memory: the heaviest searches peaked at ~105 MB per backend (sampled with `pg_log_backend_memory_contexts`; hash
  aggregates are capped at `work_mem` × `hash_mem_multiplier`, bitmaps at `work_mem`). Worst case ≈ 8 statements ×
  dynos × 105 MB. Temp files: none on common terms, 617 MB written over 60 s when broad terms were included.
- `SearchTooBroad` errors in these runs come from unscoped Transactions template words (`host fee`) only.

## Tuning done in #8944 (before → after in each commit)

| Commit                                                         | Change                                                                                                 | Effect                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fix(search): rebuild invalid … concurrent builds`             | Migrations drop an INVALID leftover of a failed concurrent build, rebuild it and fail if still invalid | Re-running a failed migration is safe (before: `IF NOT EXISTS` kept the invalid index forever)                                                        |
| `perf(search): recalibrate the Transactions planner pre-check` | 20k → 50k estimated matches/s                                                                          | Unscoped `invoice` (248k) and host-scoped `fee` (451k) run (0.5-0.8 s warm, < 7 s cold) instead of being rejected; template words stay rejected in ms |
| `perf(search): look up Expense merchant IDs before …`          | InitPlan array instead of a semi-join                                                                  | Account-scoped Transactions: rare word 62 → 16 ms, `invoice` 66 → 20 ms                                                                               |
| `perf(search): give the planner word statistics …`             | Non-partial text indexes for Expenses, items, Tiers, applications; `+ 0` on the Tiers host scope       | Expenses rare word 20 → 3 ms; Tiers `gold sponsor` 57 → 31 ms                                                                                         |
| `perf(search): run each … statement on a single core`          | `max_parallel_workers_per_gather = 0` in search transactions                                           | 8 users: 8.8 → 14.7 requests/s, p50 519 → 268 ms; single search p95 0.6 → 0.9 s                                                                       |
| `perf(search): prefetch heap pages …`                          | `effective_io_concurrency` ≥ 64 in search transactions                                                 | Cold: Orders 2.8M matches 9.1 → 6.7 s, Transactions `invoice` 7.0 → 4.8 s                                                                             |

Measured and kept as is:

- **JIT stays off** in search transactions. With `jit = on` (the server default), no case got faster; Comments
  `studio` went 0.41 → 0.62 s, Transactions rare word 12 → 22 ms, Tiers `sponsor` +15%.
- **The planner pre-check stays Transactions-only.** Cold, every other entity completes well within the budget at
  this scale (broadest: Orders 2.8M matches in 6.7 s cold, 2.7 s warm), and statement_timeout remains the backstop.
  Comments estimates are 3x low on common words, so a pre-check there would not be reliable.
- **Expenses currency and status words stay in the text** (`usd`: 531k matches in 1.06 s, `paid` 331k in 0.62 s).
  Moving them to exact filters would change matching (an Expense described as "Paid parking") without making the
  single-token searches cheaper.
- **Orders template words** (`financial contribution`, `monthly`) complete unscoped (2.7 s warm, 6.7 s cold for 2.8M
  matches): no special handling. The Transactions equivalents (13M rows) are rejected by the pre-check.
- **Shared Account eligibility helper** (`isOwnedByEligibleAccount`): index-only anti-join on 116k excluded accounts,
  hashed once per arm (~2-5 ms) on broad terms, nested-loop probes on selective ones. It grows with the number of
  deleted or private accounts in production.
- **Partial vs non-partial**: all text indexes are now non-partial except the Accounts ones (eligibility removes ~30%
  of the rows; their arms are always text-driven) and the Expenses restricted one (only rows with restricted fields).
- Known slower scoped cases, left as is: account scopes on Comments and Updates re-compute the HTML vector of each
  Comment/Update of the account (~45 µs each: 140 ms for an account with 3k Comments; a btree_gin
  `("CollectiveId", vector)` index would avoid it at the cost of another large index); Expenses account scope
  (~200-270 ms, driven by the item matches of common words: an item-side account filter was tested and was slower);
  Orders host scope on mid-frequency words (0.2-1.2 s, the planner drives from the host's accounts).

## Deployment plan

Owner: an API core developer with Heroku access to `opencollective-staging-api` and `opencollective-prod-api`
(production database credentials), with the team informed in #deployments. Deployment is a separate action from
merging; do staging first, then production.

### Prerequisites (verify on staging, then production)

```sql
-- Extensions: available, installed version and schema (Heroku installs them in `heroku_ext`)
SELECT name, default_version, installed_version FROM pg_available_extensions
WHERE name IN ('unaccent', 'pg_trgm', 'btree_gin');
SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname IN ('unaccent', 'pg_trgm', 'btree_gin');
-- The migration role can create extensions, functions and text search configurations in `public`
SELECT current_user, has_schema_privilege('public', 'CREATE') AS can_create_in_public;
SHOW search_path;           -- must resolve pg_trgm operators (`<%`) if pg_trgm lives in `heroku_ext`
SHOW jit; SHOW max_parallel_workers_per_gather; SHOW effective_io_concurrency; SHOW maintenance_work_mem;
-- Long transactions block concurrent index builds: none should be older than a few minutes
SELECT pid, now() - xact_start AS age, state, left(query, 80) FROM pg_stat_activity
WHERE xact_start < now() - interval '5 minutes' ORDER BY xact_start;
```

- `unaccent` and `btree_gin` are new; `pg_trgm` is already used. `CREATE EXTENSION` must be allowed for the
  migration role (expected on Heroku for these extensions, installed in `heroku_ext`: to verify on staging): the
  normalization migration resolves the `unaccent` schema dynamically; `btree_gin` default operator classes don't
  depend on `search_path`; `pg_trgm` operators do.
- Disk: ~1.4 GB for the indexes at the synthetic scale. Production tables are wider, budget 2-4 GB plus WAL during
  the builds.
- Not verified yet (no production access in #8944): privileges, extension schemas, `search_path`, server settings.

### Sequencing (additive only)

Migrations are additive (functions, text search configurations, extensions, then indexes) and run in this order:
normalization → Collectives → Updates → Orders → Tiers/Host applications → Expenses → Transactions → Comments. Each
index is built with `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, one statement at a time, outside a transaction (writes
continue), serially per table, then `ANALYZE` of the table. `createIndexesConcurrently`
(`migrations/lib/concurrent-indexes.ts`) drops an INVALID index left by a failed or canceled build, rebuilds it, and
fails if the result is not valid (`pg_index.indisvalid AND indisready`), so a failed migration can simply be re-run.
Indexes that already exist and are valid (built out of band) are kept.

**Build out of band before the deploy.** On staging and production, `npm run db:migrate` runs in `postinstall`, i.e.
during the Heroku build. Concurrent builds scan each table twice and wait for every transaction older than them.
Estimated at production scale: the 4 min 40 s measured here (4 vCPU, warm, quiet) × 2-4 for wider rows, colder
pages and concurrent traffic, so **~10-20 minutes in total, of which ~5-10 for Transactions**, which can exceed a
build's time limit. Instead, from a checkout of the release commit:

```bash
# 1. Staging, then production: run the migrations against the database, outside of the build
heroku pg:credentials:url DATABASE --app <app>      # owner only
PG_URL='<url>' NODE_ENV=production npm run db:migrate   # same command and SSL settings as the build's postinstall
# 2. Verify: no invalid index, sizes, statistics
#    SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid OR NOT indisready;   -- must be empty
#    SELECT indexrelid::regclass, pg_size_pretty(pg_relation_size(indexrelid)) FROM pg_index
#      JOIN pg_class c ON c.oid = indexrelid WHERE c.relname LIKE '%pg_search%';
# 3. Deploy the API as usual: the build's migration step finds nothing left to do
```

Run it outside peak hours: each build uses one backend (plus parallel maintenance workers for btrees) and
`maintenance_work_mem`; GIN builds on Transactions and Comments are the longest. If a build is canceled
(`pg_cancel_backend`, deploy aborted), re-run the same command.

### Deploy and enable

1. Deploy the API (OpenSearch stays the default; PostgreSQL search is idle until someone opts in), then the frontend
   (the backend selector only appears for team members who enable the `SEARCH_POSTGRES_BACKEND` preview). The API
   rejects `backend: POSTGRES` in production unless the user enabled that preview (and `SEARCH_COMMAND`).
2. Team members enable the preview in their settings and compare results with OpenSearch.
3. Watch: database CPU, `pg_stat_statements` for statements starting with `with "arms"`, Sentry `SearchFailed`, the
   rate of `SearchTooBroad`.

### Return to OpenSearch

- Per request: `backend: OPENSEARCH` (the default when omitted); in the frontend, the backend switch or turning the
  preview off (stored per browser and per user).
- For everyone, without a deploy: set `SEARCH_POSTGRES_ENABLED=false` on the API app (dynos restart): every
  `backend: POSTGRES` request then fails with a visible error and OpenSearch keeps working. Other knobs:
  `SEARCH_POSTGRES_MAX_CONCURRENT_QUERIES`, `SEARCH_POSTGRES_CONCURRENCY_PER_REQUEST`, `SEARCH_POSTGRES_WORK_MEM`.
- Removing the indexes (only if they cause write or disk issues): `npm run db:migrate:undo` per migration (each
  `DROP INDEX CONCURRENTLY`), newest first. OpenSearch never depended on them.

## Missing production evidence

These must be measured before considering anything beyond a team preview:

- Production sizes and distributions: real word frequencies (template descriptions, default tier names, common
  comment words), number of deleted/private accounts, largest hosts and accounts, Orders/Expenses/Comments counts.
  The synthetic vocabulary and skew decide the broad-term numbers above.
- Production hardware, cache hit ratio and settings (`shared_buffers`, RAM vs data size, disk latency, `jit`,
  parallel settings): cold numbers here are 2-5x the warm ones.
- Concurrent production traffic: search queries compete with the real workload on the primary (Kysely uses the
  primary). Index builds compete with writes; autovacuum and GIN pending-list flushes on the busiest tables.
- Extension privileges and schemas, migration duration on the real tables, invalid-index handling on a real failure.
- Relevance: no comparison with OpenSearch results on real queries yet.
