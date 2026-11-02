/* eslint-disable no-console */
/**
 * Benchmark of the PostgreSQL search provider (opencollective#8944). See `docs/postgres-search.md`.
 *
 * Runs the real provider code (`PostgresProvider.search`: adapters, ranked query, budget, concurrency caps, planner
 * pre-check) against the database of `PG_URL`, with fake users (root, administrators, anonymous). Read-only, except the
 * `writes` phase (rolled back) and the `--with-writes` concurrent writer (inserts benchmark Transactions, deleted after).
 *
 *   PG_URL=postgres://.../oc_search_bench PG_MAX_CONNECTIONS=50 \
 *     npm run script scripts/search/postgres-search-benchmark.ts -- --phase all --out /tmp/bench.json
 *
 * Phases:
 * - `info`: PostgreSQL version, settings, extensions, table and search index sizes, invalid indexes
 * - `matrix`: every case (entity x term x role x scope x page) `--runs` times, sequentially: latency, total, errors
 * - `explain`: `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` of the exact SQL of each case (same transaction settings)
 * - `concurrency`: `--users` virtual users for `--duration` seconds sending frontend-like requests (all entities,
 *   limit 5); reports request p50/p95/p99, errors, search slot waits, pool waits, a `SELECT 1` canary on the same pool
 *   (unrelated workload) and, with `--with-writes`, single-row Transactions inserts
 * - `writes`: single-row insert latency and WAL per row on Transactions, Comments, Updates, Expenses and Orders, with
 *   and without the search indexes (indexes dropped inside a rolled-back transaction: run it alone; FK triggers are
 *   skipped, superuser only)
 *
 * Default cases use the vocabulary of the synthetic dataset (`postgres-search-benchmark-dataset.ts`). Against another
 * database, pass `--cases <file.json>` (same shape as `getDefaultCases`).
 */

import '../../server/env';

import fs from 'fs';

import { Command } from 'commander';
import config from 'config';
import { CompiledQuery } from 'kysely';
import { sum } from 'lodash';

import { getKysely } from '../../server/lib/kysely';
import { getPostgresSearchAdapter } from '../../server/lib/search/providers/postgres/adapters';
import { estimateMatches } from '../../server/lib/search/providers/postgres/estimates';
import { getPostgresSearchQueueStats, runWithSearchBudget } from '../../server/lib/search/providers/postgres/execution';
import { PostgresProvider } from '../../server/lib/search/providers/postgres/index';
import { parseSearchInput } from '../../server/lib/search/providers/postgres/input';
import {
  buildCappedSearchQuery,
  buildRankedSearchQuery,
} from '../../server/lib/search/providers/postgres/query-builder';
import { SearchEntity, SearchEntityRequest, SearchProvider, SearchRequest } from '../../server/lib/search/types';
import type { Collective, User } from '../../server/models';
import { sequelize } from '../../server/models';

type Role = 'anonymous' | 'root' | 'collectiveAdmin' | 'hostAdmin';
type Case = {
  entity: SearchEntity;
  term: string;
  role: Role;
  scope?: 'host' | 'account' | 'hostAndAccount';
  limit?: number;
  offset?: number;
  label?: string;
};

type Fixtures = {
  bigHostId: number;
  bigHostAccounts: number;
  smallHostId: number;
  bigAccountId: number;
  bigAccountTransactions: number;
  collectiveAdminIds: number[];
};

const ENTITIES = Object.values(SearchEntity);
const now = () => Number(process.hrtime.bigint()) / 1e6;

const percentile = (values: number[], p: number): number => {
  if (!values.length) {
    return NaN;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

const summarize = (values: number[]) => ({
  n: values.length,
  p50: Math.round(percentile(values, 50)),
  p95: Math.round(percentile(values, 95)),
  p99: Math.round(percentile(values, 99)),
  max: Math.round(Math.max(...values, 0)),
});

const query = async <T = Record<string, unknown>>(text: string, parameters: unknown[] = []): Promise<T[]> => {
  const result = await getKysely().executeQuery(CompiledQuery.raw(text, parameters));
  return result.rows as T[];
};

/** Accounts and users used by the cases, chosen from the data (largest host, busiest account...) */
const getFixtures = async (): Promise<Fixtures> => {
  const hosts = await query<{ id: number; count: number }>(`
    SELECT "HostCollectiveId" AS id, count(*)::int AS count FROM "Collectives"
    WHERE "isActive" = TRUE AND "deletedAt" IS NULL AND "HostCollectiveId" IS NOT NULL AND id <> "HostCollectiveId"
    GROUP BY 1 ORDER BY 2 DESC LIMIT 50
  `);
  const accounts = await query<{ id: number; count: number }>(`
    SELECT "CollectiveId" AS id, count(*)::int AS count FROM "Orders" WHERE "deletedAt" IS NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1
  `);
  const bigAccountId = accounts[0].id;
  const [{ count: bigAccountTransactions }] = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM "Transactions" WHERE "CollectiveId" = $1 AND "deletedAt" IS NULL`,
    [bigAccountId],
  );
  // Administrators of three ordinary collectives (one busy, two average)
  const collectives = await query<{ id: number }>(`
    SELECT id FROM "Collectives" WHERE type = 'COLLECTIVE' AND "isActive" = TRUE AND "deletedAt" IS NULL AND "isPrivate" = FALSE
    ORDER BY md5(id::text) LIMIT 2
  `);
  return {
    bigHostId: hosts[0].id,
    bigHostAccounts: hosts[0].count,
    smallHostId: hosts[hosts.length - 1].id,
    bigAccountId,
    bigAccountTransactions,
    collectiveAdminIds: [bigAccountId, ...collectives.map(c => c.id)],
  };
};

/** Terms of the synthetic dataset: broad (templated/common), common, selective, per entity */
const TERMS: Record<SearchEntity, { broad: string[]; common: string[]; selective: string[] }> = {
  [SearchEntity.ACCOUNTS]: {
    broad: ['foundation', 'co'],
    common: ['open source', 'foundatoin'],
    selective: ['kedalla'],
  },
  [SearchEntity.UPDATES]: { broad: ['foundation'], common: ['music art'], selective: ['planure'] },
  [SearchEntity.EXPENSES]: { broad: ['travel', 'usd', 'paid'], common: ['travel hotel'], selective: ['kedalla'] },
  [SearchEntity.ORDERS]: {
    broad: ['monthly', 'financial contribution', 'sponsor'],
    common: ['backer'],
    selective: ['ratear'],
  },
  [SearchEntity.TRANSACTIONS]: {
    broad: ['financial contribution', 'fee', 'platform tip'],
    common: ['invoice', 'host fee'],
    selective: ['batontha'],
  },
  [SearchEntity.COMMENTS]: { broad: ['studio', 'water'], common: ['water studio'], selective: ['siwoodor'] },
  [SearchEntity.TIERS]: { broad: ['sponsor'], common: ['gold sponsor', 'community'], selective: ['busasu'] },
  [SearchEntity.HOST_APPLICATIONS]: { broad: ['community'], common: ['music art'], selective: ['busasu'] },
};

const getDefaultCases = (): Case[] => {
  const cases: Case[] = [];
  for (const entity of ENTITIES) {
    const { broad, common, selective } = TERMS[entity];
    const publicEntity = ![SearchEntity.COMMENTS, SearchEntity.HOST_APPLICATIONS].includes(entity);
    for (const term of [...broad, ...common, ...selective]) {
      if (publicEntity) {
        cases.push({ entity, term, role: 'anonymous' });
      }
      cases.push({ entity, term, role: 'root' });
      cases.push({ entity, term, role: 'hostAdmin' });
      cases.push({ entity, term, role: 'collectiveAdmin' });
      cases.push({ entity, term, role: 'root', scope: 'host' });
      cases.push({ entity, term, role: 'root', scope: 'account' });
    }
    for (const term of broad.slice(0, 1)) {
      cases.push({ entity, term, role: 'root', limit: 50, offset: 5000, label: 'deep page' });
      cases.push({ entity, term, role: 'root', scope: 'hostAndAccount' });
    }
  }
  return cases;
};

const getRemoteUser = (role: Role, fixtures: Fixtures): User | null => {
  if (role === 'anonymous') {
    return null;
  }
  const adminIds =
    role === 'hostAdmin' ? [fixtures.bigHostId] : role === 'collectiveAdmin' ? fixtures.collectiveAdminIds : [];
  return { isRoot: () => role === 'root', getAdministratedCollectiveIds: () => adminIds } as unknown as User;
};

const getRequest = (c: Case, fixtures: Fixtures, timeoutInMs: number): SearchRequest => ({
  provider: SearchProvider.POSTGRES,
  term: c.term,
  scope: {
    account:
      c.scope === 'account' || c.scope === 'hostAndAccount' ? ({ id: fixtures.bigAccountId } as Collective) : null,
    host: c.scope === 'host' || c.scope === 'hostAndAccount' ? ({ id: fixtures.bigHostId } as Collective) : null,
  },
  remoteUser: getRemoteUser(c.role, fixtures),
  isRoot: c.role === 'root',
  timeoutInMs,
  useTopHits: false,
});

const getEntityRequest = (c: Case): SearchEntityRequest => ({
  entity: c.entity,
  params: {},
  forbidPrivate: c.role === 'anonymous',
  limit: c.limit ?? 10,
  offset: c.offset ?? 0,
});

const caseLabel = (c: Case) =>
  [c.entity, JSON.stringify(c.term), c.role, c.scope || 'unscoped', c.offset ? `offset ${c.offset}` : '', c.label || '']
    .filter(Boolean)
    .join(' | ');

const runCase = async (c: Case, fixtures: Fixtures, timeoutInMs: number) => {
  const startedAt = now();
  const [result] = await PostgresProvider.search(getRequest(c, fixtures, timeoutInMs), [getEntityRequest(c)]);
  const ms = now() - startedAt;
  if (result instanceof Error) {
    return { ms, error: (result as Error & { extensions?: { code?: string } }).extensions?.code || result.message };
  }
  return { ms, total: result?.totalCount ?? 0, maxScore: result?.maxScore ?? 0, hits: result?.hits.length ?? 0 };
};

const phaseInfo = async () => {
  const [version] = await query<{ version: string }>(`SELECT version()`);
  const settings = await query(`
    SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers', 'effective_cache_size', 'work_mem',
      'maintenance_work_mem', 'jit', 'random_page_cost', 'max_parallel_workers_per_gather', 'max_connections',
      'default_statistics_target', 'gin_pending_list_limit', 'max_wal_size', 'effective_io_concurrency')
    ORDER BY name
  `);
  const extensions = await query(`
    SELECT e.extname, e.extversion, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1
  `);
  const tables = await query(`
    SELECT c.relname AS table, c.reltuples::bigint AS rows, pg_size_pretty(pg_relation_size(c.oid)) AS heap,
      pg_size_pretty(pg_indexes_size(c.oid)) AS indexes, pg_size_pretty(pg_total_relation_size(c.oid)) AS total
    FROM pg_class c WHERE c.relname IN ('Collectives', 'Transactions', 'Orders', 'Subscriptions', 'Expenses', 'ExpenseItems',
      'Updates', 'Comments', 'Conversations', 'Tiers', 'HostApplications') ORDER BY pg_total_relation_size(c.oid) DESC
  `);
  const indexes = await query(`
    SELECT i.indexrelid::regclass::text AS index, i.indrelid::regclass::text AS table,
      pg_size_pretty(pg_relation_size(i.indexrelid)) AS size, i.indisvalid AS valid
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname LIKE '%pg_search%' ORDER BY pg_relation_size(i.indexrelid) DESC
  `);
  const invalid = await query(`SELECT indexrelid::regclass::text AS index FROM pg_index WHERE NOT indisvalid`);
  const accounts = await query(`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE "deletedAt" IS NULL)::int AS undeleted,
      count(*) FILTER (WHERE "deletedAt" IS NOT NULL OR "isPrivate" = TRUE)::int AS excluded_deleted_or_private
    FROM "Collectives"
  `);
  return { version: version.version, settings, extensions, tables, indexes, invalid, accounts };
};

const phaseMatrix = async (cases: Case[], fixtures: Fixtures, runs: number, timeoutInMs: number) => {
  const results = [];
  for (const c of cases) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      samples.push(await runCase(c, fixtures, timeoutInMs));
    }
    const last = samples[samples.length - 1];
    const row = {
      case: caseLabel(c),
      total: 'total' in last ? last.total : null,
      error: 'error' in last ? last.error : null,
      ms: samples.map(s => Math.round(s.ms * 10) / 10),
    };
    console.log(`${row.case} | ${row.error ?? `total=${row.total}`} | ${row.ms.join(' / ')} ms`);
    results.push(row);
  }
  return results;
};

/** Same access rules as the provider (`getAccess` in `providers/postgres/index.ts`) */
const getAccess = (c: Case, fixtures: Fixtures) => {
  const user = getRemoteUser(c.role, fixtures);
  return user
    ? {
        forbidPrivate: false,
        isRoot: user.isRoot(),
        adminIds: user.getAdministratedCollectiveIds(),
        deniedOAuthScopes: [],
      }
    : { forbidPrivate: true, isRoot: false, adminIds: [], deniedOAuthScopes: [] };
};

const phaseExplain = async (cases: Case[], fixtures: Fixtures, outDir: string | null) => {
  const plans = [];
  for (const c of cases) {
    const request = getRequest(c, fixtures, 30_000);
    const entityRequest = getEntityRequest(c);
    try {
      const plan = await runWithSearchBudget({ deadline: Date.now() + 60_000 }, async trx => {
        const adapter = getPostgresSearchAdapter(c.entity);
        const scope = { accountId: request.scope.account?.id ?? null, hostId: request.scope.host?.id ?? null };
        const arms = adapter.buildArms(trx, {
          input: parseSearchInput(c.term),
          scope,
          access: getAccess(c, fixtures),
          params: {},
        });
        if (!arms.length) {
          return ['(no arms: nothing to search with this access)'];
        }
        const estimate = await estimateMatches(trx, arms);
        const page = { limit: entityRequest.limit, offset: entityRequest.offset };
        const compiled = (
          adapter.constantScorePerArm
            ? buildCappedSearchQuery(trx, arms, {
                ...page,
                cap: Number(config.search.postgres.maxCountedMatches),
                scoped: Boolean(scope.accountId || scope.hostId),
              })
            : buildRankedSearchQuery(trx, arms, page)
        ).compile();
        const result = await trx.executeQuery(
          CompiledQuery.raw(`EXPLAIN (ANALYZE, BUFFERS, SETTINGS) ${compiled.sql}`, [...compiled.parameters]),
        );
        return [
          ...result.rows.map(row => row['QUERY PLAN'] as string),
          `Planner estimate of the matches (pre-check): ${estimate}`,
          '',
          `-- SQL (parameters: ${JSON.stringify(compiled.parameters)})`,
          compiled.sql,
        ];
      });
      const execution = plan.find(line => line.startsWith('Execution Time'));
      const estimate = plan.find(line => line.startsWith('Planner estimate'))?.split(': ')[1];
      const seqScans = plan.filter(line =>
        /Seq Scan on "?(Collectives|Transactions|Expenses|Comments|Orders)/.test(line),
      );
      console.log(
        `${caseLabel(c)} | ${execution} | estimate ${estimate} | seq scans on big tables: ${seqScans.length}`,
      );
      plans.push({ case: caseLabel(c), plan });
    } catch (error) {
      console.log(`${caseLabel(c)} | EXPLAIN failed: ${error.message}`);
      plans.push({ case: caseLabel(c), error: error.message });
    }
  }
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [i, p] of plans.entries()) {
      fs.writeFileSync(
        `${outDir}/${String(i).padStart(3, '0')}.txt`,
        `${p.case}\n\n${(p.plan || [p.error]).join('\n')}\n`,
      );
    }
  }
  return plans.map(p => ({ case: p.case, execution: p.plan?.find(l => l.startsWith('Execution Time')) ?? p.error }));
};

const getDatabaseCounters = async () => {
  const [db] = await query<Record<string, string>>(`
    SELECT blks_read, blks_hit, temp_bytes, temp_files, xact_commit, (SELECT wal_bytes FROM pg_stat_wal) AS wal_bytes
    FROM pg_stat_database WHERE datname = current_database()
  `);
  return Object.fromEntries(Object.entries(db).map(([k, v]) => [k, Number(v)]));
};

/** Frontend-like requests: the command menu sends every entity with limit 5, the results page one tab + counts */
const getWorkloadRequests = (fixtures: Fixtures, terms: string[]) => {
  const requests: Array<{ role: Role; term: string; entities: SearchEntityRequest[]; scope?: Case['scope'] }> = [];
  for (const term of terms) {
    for (const role of ['root', 'hostAdmin', 'collectiveAdmin', 'root'] as Role[]) {
      requests.push({
        role,
        term,
        entities: ENTITIES.map(entity => getEntityRequest({ entity, term, role, limit: 5 })),
      });
    }
    requests.push({
      role: 'root',
      term,
      scope: 'host',
      entities: ENTITIES.map(entity => getEntityRequest({ entity, term, role: 'root', limit: 5 })),
    });
  }
  return requests;
};

const phaseConcurrency = async (
  fixtures: Fixtures,
  {
    users,
    durationS,
    timeoutInMs,
    withWrites,
    terms,
  }: { users: number; durationS: number; timeoutInMs: number; withWrites: boolean; terms: string[] },
) => {
  const requests = getWorkloadRequests(fixtures, terms);
  const latencies: number[] = [];
  const entityErrors: Record<string, number> = {};
  let entityResults = 0;
  const canary: number[] = [];
  const inserts: number[] = [];
  const insertedIds: number[] = [];
  const samples = { slotsWaiting: [] as number[], poolWaiting: [] as number[], poolUsing: [] as number[] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = (sequelize.connectionManager as any).pool;
  const deadline = Date.now() + durationS * 1000;
  const before = await getDatabaseCounters();
  let stop = false;

  const sampler = setInterval(() => {
    const stats = getPostgresSearchQueueStats();
    samples.slotsWaiting.push(stats.waiting);
    samples.poolWaiting.push(pool?.waiting ?? 0);
    samples.poolUsing.push(pool?.using ?? 0);
  }, 50);

  const user = async (index: number) => {
    let i = index;
    while (Date.now() < deadline) {
      const r = requests[i++ % requests.length];
      const c: Case = { entity: SearchEntity.ACCOUNTS, term: r.term, role: r.role, scope: r.scope };
      const startedAt = now();
      const results = await PostgresProvider.search(getRequest(c, fixtures, timeoutInMs), r.entities);
      latencies.push(now() - startedAt);
      for (const result of results) {
        entityResults++;
        if (result instanceof Error) {
          const code = (result as Error & { extensions?: { code?: string } }).extensions?.code || result.message;
          entityErrors[code] = (entityErrors[code] || 0) + 1;
        }
      }
    }
  };

  const canaryLoop = async () => {
    while (!stop) {
      const startedAt = now();
      await sequelize.query('SELECT 1');
      canary.push(now() - startedAt);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };

  const writer = async () => {
    let n = 0;
    while (!stop) {
      const startedAt = now();
      const [rows] = await sequelize.query(
        `INSERT INTO "Transactions" (type, description, amount, currency, "createdAt", "updatedAt", "CollectiveId", "FromCollectiveId",
          "HostCollectiveId", "TransactionGroup", uuid, kind, "publicId", data, "hostCurrency", "amountInHostCurrency", "netAmountInCollectiveCurrency")
        VALUES ('CREDIT', 'Financial contribution to benchmark writer', 1000, 'USD', now(), now(), :account, :account, :host,
          gen_random_uuid(), gen_random_uuid(), 'CONTRIBUTION', :publicId, '{"charge":{"id":"ch_benchmark"}}', 'USD', 1000, 1000)
        RETURNING id`,
        {
          replacements: {
            account: fixtures.bigAccountId,
            host: fixtures.bigHostId,
            publicId: `tx_benchwriter_${process.pid}_${n++}`,
          },
        },
      );
      inserts.push(now() - startedAt);
      insertedIds.push(...(rows as Array<{ id: number }>).map(row => row.id));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  const background = [canaryLoop(), ...(withWrites ? [writer()] : [])];
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: users }, (_, i) => user(i * 7)));
  const elapsedS = (Date.now() - startedAt) / 1000;
  stop = true;
  clearInterval(sampler);
  await Promise.all(background);
  const after = await getDatabaseCounters();
  if (withWrites && insertedIds.length) {
    // Benchmark rows are new and unreferenced: skip FK triggers, whose checks scan unindexed referencing columns
    await sequelize.transaction(async transaction => {
      await sequelize.query(`SET LOCAL session_replication_role = replica`, { transaction });
      await sequelize.query(`DELETE FROM "Transactions" WHERE id IN (:ids)`, {
        replacements: { ids: insertedIds },
        transaction,
      });
    });
  }

  return {
    users,
    durationS: Math.round(elapsedS),
    requests: latencies.length,
    requestsPerSecond: Math.round((latencies.length / elapsedS) * 10) / 10,
    requestLatencyMs: summarize(latencies),
    entityResults,
    entityErrors,
    searchSlotsWaiting: {
      avg: Math.round((sum(samples.slotsWaiting) / samples.slotsWaiting.length) * 10) / 10,
      max: Math.max(...samples.slotsWaiting),
    },
    poolWaiting: {
      avg: Math.round((sum(samples.poolWaiting) / samples.poolWaiting.length) * 10) / 10,
      max: Math.max(...samples.poolWaiting),
    },
    poolUsing: {
      avg: Math.round((sum(samples.poolUsing) / samples.poolUsing.length) * 10) / 10,
      max: Math.max(...samples.poolUsing),
    },
    canarySelect1Ms: summarize(canary),
    insertTransactionMs: withWrites ? summarize(inserts) : null,
    database: Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]])),
  };
};

/** Single-row inserts (copies of existing rows), with and without the search indexes, rolled back */
const WRITE_TABLES: Array<{ table: string; columnsToChange: Record<string, string> }> = [
  { table: 'Transactions', columnsToChange: { publicId: `'tx_bw' || n`, uuid: 'gen_random_uuid()' } },
  { table: 'Comments', columnsToChange: { publicId: `'cmt_bw' || n` } },
  { table: 'Updates', columnsToChange: { publicId: `'upd_bw' || n`, slug: `'bench-write-' || n` } },
  { table: 'Expenses', columnsToChange: { publicId: `'ex_bw' || n` } },
  { table: 'Orders', columnsToChange: { publicId: `'or_bw' || n` } },
];

const phaseWrites = async (rows: number) => {
  const results = [];
  for (const { table, columnsToChange } of WRITE_TABLES) {
    const columns = (
      await query<{ name: string }>(
        `SELECT attname AS name FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' AND attname <> 'id' ORDER BY attnum`,
        [`"${table}"`],
      )
    ).map(c => c.name);
    const searchIndexes = (
      await query<{ name: string }>(
        `SELECT i.indexrelid::regclass::text AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = $1::regclass AND c.relname LIKE '%pg_search%'`,
        [`"${table}"`],
      )
    ).map(i => i.name);
    const select = columns.map(c => columnsToChange[c] ?? `"${c}"`).join(', ');
    const source = await query<{ id: number }>(`SELECT id FROM "${table}" ORDER BY id DESC LIMIT $1`, [rows]);
    const measure = async (dropSearchIndexes: boolean) => {
      return getKysely()
        .connection()
        .execute(async db => {
          await db.executeQuery(CompiledQuery.raw('BEGIN'));
          try {
            // Synthetic rows reference users that don't exist: skip FK triggers (same cost with and without indexes)
            await db.executeQuery(CompiledQuery.raw(`SET LOCAL session_replication_role = replica`));
            for (const index of dropSearchIndexes ? searchIndexes : []) {
              await db.executeQuery(CompiledQuery.raw(`DROP INDEX ${index}`));
            }
            const [{ lsn: lsnBefore }] = (
              await db.executeQuery<{ lsn: string }>(
                CompiledQuery.raw(`SELECT pg_current_wal_insert_lsn()::text AS lsn`),
              )
            ).rows;
            const timings = [];
            for (const [n, { id }] of source.entries()) {
              const startedAt = now();
              await db.executeQuery(
                CompiledQuery.raw(
                  `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) SELECT ${select} FROM "${table}", (SELECT $2::int AS n) n WHERE id = $1`,
                  [id, n + 1],
                ),
              );
              timings.push(now() - startedAt);
            }
            const [{ bytes }] = (
              await db.executeQuery<{ bytes: string }>(
                CompiledQuery.raw(`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn) AS bytes`, [
                  lsnBefore,
                ]),
              )
            ).rows;
            return {
              ...summarize(timings.map(t => t * 1000)),
              walBytesPerRow: Math.round(Number(bytes) / source.length),
            };
          } finally {
            await db.executeQuery(CompiledQuery.raw('ROLLBACK'));
          }
        });
    };
    // Warm up (caches, full-page writes after a checkpoint), then alternate so that neither variant is favored
    await measure(false);
    await measure(true);
    const withoutIndexes = await measure(true);
    const withIndexes = await measure(false);
    const row = {
      table,
      searchIndexes,
      rows: source.length,
      withSearchIndexesUs: withIndexes,
      withoutSearchIndexesUs: withoutIndexes,
    };
    console.log(JSON.stringify(row));
    results.push(row);
  }
  return results;
};

const main = async () => {
  const program = new Command()
    .option('--phase <phase>', 'info, matrix, explain, concurrency, writes or all', 'all')
    .option('--entity <entities>', 'Comma-separated entities (default: all)')
    .option('--grep <text>', 'Only cases whose label contains this text')
    .option('--cases <file>', 'JSON file with the cases')
    .option('--runs <n>', 'Runs per case (matrix)', '3')
    .option('--timeout <ms>', 'Search timeout (GraphQL `timeout`, default 10000)', '10000')
    .option('--users <list>', 'Concurrent virtual users (concurrency), comma-separated', '1,8,32')
    .option('--duration <s>', 'Duration of each concurrency step', '60')
    .option('--with-writes', 'Concurrent single-row Transactions inserts during the concurrency phase')
    .option('--broad', 'Include the broad terms in the concurrency workload (default: common and selective terms)')
    .option('--write-rows <n>', 'Rows per table (writes)', '500')
    .option('--explain-dir <dir>', 'Write one plan file per case')
    .option('--out <file>', 'Write all results as JSON')
    .parse();
  const options = program.opts();
  const phases =
    options.phase === 'all' ? ['info', 'matrix', 'explain', 'concurrency', 'writes'] : options.phase.split(',');
  const timeoutInMs = Number(options.timeout);
  const output: Record<string, unknown> = { startedAt: new Date().toISOString(), options };

  const fixtures = await getFixtures();
  output.fixtures = fixtures;
  console.log('Fixtures', fixtures);
  let cases: Case[] = options.cases ? JSON.parse(fs.readFileSync(options.cases, 'utf8')) : getDefaultCases();
  if (options.entity) {
    const entities = options.entity.split(',');
    cases = cases.filter(c => entities.includes(c.entity));
  }
  if (options.grep) {
    cases = cases.filter(c => caseLabel(c).includes(options.grep));
  }

  for (const phase of phases) {
    console.log(`\n## ${phase}`);
    const startedAt = Date.now();
    if (phase === 'info') {
      output.info = await phaseInfo();
      console.log(JSON.stringify(output.info, null, 2));
    } else if (phase === 'matrix') {
      output.matrix = await phaseMatrix(cases, fixtures, Number(options.runs), timeoutInMs);
    } else if (phase === 'explain') {
      output.explain = await phaseExplain(cases, fixtures, options.explainDir || null);
    } else if (phase === 'concurrency') {
      const terms = [
        ...new Set(
          ENTITIES.flatMap(e => [...TERMS[e].common, ...TERMS[e].selective, ...(options.broad ? TERMS[e].broad : [])]),
        ),
      ];
      const steps = [];
      for (const users of options.users.split(',').map(Number)) {
        const step = await phaseConcurrency(fixtures, {
          users,
          durationS: Number(options.duration),
          timeoutInMs,
          withWrites: Boolean(options.withWrites),
          terms,
        });
        console.log(JSON.stringify(step));
        steps.push(step);
      }
      output.concurrency = steps;
    } else if (phase === 'writes') {
      output.writes = await phaseWrites(Number(options.writeRows));
    }
    console.log(`(${phase}: ${Math.round((Date.now() - startedAt) / 1000)} s)`);
  }

  if (options.out) {
    fs.writeFileSync(options.out, JSON.stringify(output, null, 2));
  }
  await sequelize.close();
};

main().catch(error => {
  console.error(error);
  process.exit(1);
});
