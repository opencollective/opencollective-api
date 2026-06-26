/**
 * Benchmark searchCollectivesInDB with EXPLAIN ANALYZE on page and count queries.
 *
 * Run:
 *   npm run benchmark:sql-search
 *   npm run benchmark:sql-search -- --verbose
 *   npm run benchmark:sql-search -- --logSQL
 *   npm run benchmark:sql-search -- --user testuser --limit 50
 *   npm run benchmark:sql-search -- --user testuser --verbose --logSQL
 */

import '../../server/env';

import { Command } from 'commander';
import express from 'express';
import { QueryTypes } from 'sequelize';

import { CollectiveType } from '../../server/constants/collectives';
import { ORDER_BY_PSEUDO_FIELDS } from '../../server/graphql/v2/enum/OrderByFieldType';
import logger from '../../server/lib/logger';
import {
  buildSearchCollectivesQuery,
  searchCollectivesInDB,
  type SearchCollectivesInDBOptions,
} from '../../server/lib/sql-search';
import models, { sequelize } from '../../server/models';

const SEARCH_TERMS = ['open source', 'backyourstack'] as const;
const HOST_COLLECTIVE_ID = 11004;
const OFFSET = 0;

type BenchmarkCase = {
  name: string;
  options?: SearchCollectivesInDBOptions;
};

type PlanComplexity = {
  rootNode: string;
  costStart: number;
  costEnd: number;
  estimatedRows: number;
  actualRows: number;
  nodeCount: number;
};

type ExplainStats = {
  planningTimeMs: number;
  executionTimeMs: number;
  totalTimeMs: number;
  complexity: PlanComplexity;
  plan: string;
};

const parsePlanComplexity = (plan: string): PlanComplexity => {
  const executionSection = plan.split(/^Planning:/m)[0];
  const nodeLines = executionSection.split('\n').filter(line => line.includes('(cost='));
  const rootLine = nodeLines[0]?.trim() ?? '';
  const rootMatch = rootLine.match(
    /^(.+?)\s+\(cost=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)(?:\s+width=\d+)?\)\s+\(actual time=[\d.]+\.\.[\d.]+\s+rows=(\d+)/,
  );

  return {
    rootNode: rootMatch?.[1]?.trim() ?? 'unknown',
    costStart: parseFloat(rootMatch?.[2] ?? 'NaN'),
    costEnd: parseFloat(rootMatch?.[3] ?? 'NaN'),
    estimatedRows: parseInt(rootMatch?.[4] ?? '0', 10),
    actualRows: parseInt(rootMatch?.[5] ?? '0', 10),
    nodeCount: nodeLines.length,
  };
};

const parseExplainStats = (rows: { 'QUERY PLAN': string }[]): ExplainStats => {
  const plan = rows.map(row => row['QUERY PLAN']).join('\n');
  const planningTimeMs = parseFloat(plan.match(/Planning Time: ([\d.]+) ms/)?.[1] ?? 'NaN');
  const executionTimeMs = parseFloat(plan.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? 'NaN');

  return {
    planningTimeMs,
    executionTimeMs,
    totalTimeMs: planningTimeMs + executionTimeMs,
    complexity: parsePlanComplexity(plan),
    plan,
  };
};

const formatMs = (ms: number): string => {
  if (isNaN(ms)) {
    return 'NaN';
  }

  return `${ms < 10 ? ms.toFixed(3) : ms.toFixed(2)}ms`;
};

const formatQuerySummary = (stats: ExplainStats): string => {
  const { complexity } = stats;
  const cost =
    isNaN(complexity.costStart) || isNaN(complexity.costEnd)
      ? 'cost=?'
      : `cost=${complexity.costStart}..${complexity.costEnd}`;

  return `${formatMs(stats.totalTimeMs)} (${cost}, ${complexity.rootNode}, nodes=${complexity.nodeCount})`;
};

const formatCaseLine = (
  caseName: string,
  pageCount: number,
  totalCount: number,
  pageStats: ExplainStats,
  countStats: ExplainStats,
): string => {
  const grandTotal = pageStats.totalTimeMs + countStats.totalTimeMs;

  return [
    caseName,
    `total ${formatMs(grandTotal)}`,
    `returned ${pageCount}/${totalCount}`,
    `page: ${formatQuerySummary(pageStats)}`,
    `count: ${formatQuerySummary(countStats)}`,
  ].join(' | ');
};

const BENCHMARK_CASES: BenchmarkCase[] = [
  { name: 'default' },
  { name: 'typeCollective', options: { types: [CollectiveType.COLLECTIVE] } },
  { name: 'onlyActive', options: { onlyActive: true } },
  { name: 'isHost', options: { isHost: true } },
  {
    name: 'openHosts',
    options: {
      isHost: true,
      onlyOpenHosts: true,
      orderBy: { field: ORDER_BY_PSEUDO_FIELDS.HOST_RANK, direction: 'DESC' },
    },
  },
  { name: 'countryUS', options: { countries: ['US'] } },
  { name: 'tagAnd', options: { tags: ['open source'], tagSearchOperator: 'AND' } },
  {
    name: 'tagOr',
    options: { tags: ['open source', 'javascript'], tagSearchOperator: 'OR' },
  },
  { name: 'includeArchived', options: { includeArchived: true } },
  { name: 'skipRecentAccounts', options: { skipRecentAccounts: true } },
  { name: 'verifiedOrFirstParty', options: { isHost: true, isVerified: true } },
  { name: 'hostFilter', options: { hostCollectiveIds: [HOST_COLLECTIVE_ID] } },
  {
    name: 'orderByBalance',
    options: { orderBy: { field: ORDER_BY_PSEUDO_FIELDS.BALANCE, direction: 'DESC' } },
  },
  {
    name: 'orderByActivity',
    options: { orderBy: { field: ORDER_BY_PSEUDO_FIELDS.ACTIVITY, direction: 'DESC' } },
  },
  {
    name: 'consolidatedBalanceGte',
    options: { consolidatedBalance: { gte: { valueInCents: 10000, currency: 'USD' } } },
  },
  { name: 'lastTransactionFrom', options: { lastTransactionFrom: new Date('2024-01-01') } },
];

const runExplainAnalyze = async (
  label: string,
  sql: string,
  replacements: Record<string, unknown>,
  verbose: boolean,
  logSQL: boolean,
  caseName: string,
  term: string,
): Promise<ExplainStats> => {
  const rows = (await sequelize.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, {
    replacements,
    type: QueryTypes.SELECT,
    logging: logSQL ? console.log : undefined,
  })) as { 'QUERY PLAN': string }[];

  const stats = parseExplainStats(rows);

  if (verbose) {
    logger.info(`[${caseName}] "${term}" ${label} EXPLAIN ANALYZE:\n${stats.plan}`);
  }

  return stats;
};

const mergeOptions = (
  baseOptions: SearchCollectivesInDBOptions | undefined,
  isRoot: boolean,
): SearchCollectivesInDBOptions => ({
  ...baseOptions,
  isRoot,
});

const runCase = async (
  req: express.Request,
  caseDef: BenchmarkCase,
  term: string,
  limit: number,
  isRoot: boolean,
  verbose: boolean,
  logSQL: boolean,
): Promise<string> => {
  const options = mergeOptions(caseDef.options, isRoot);

  const [results, totalCount] = await searchCollectivesInDB(req, term, OFFSET, limit, options);
  const { pageSql, countSql, replacements } = await buildSearchCollectivesQuery(req, term, OFFSET, limit, options);

  const [pageStats, countStats] = await Promise.all([
    runExplainAnalyze('page', pageSql, replacements, verbose, logSQL, caseDef.name, term),
    runExplainAnalyze('count', countSql, replacements, verbose, logSQL, caseDef.name, term),
  ]);

  return formatCaseLine(caseDef.name, results.length, totalCount, pageStats, countStats);
};

const resolveRequest = async (
  userSlug?: string,
): Promise<{ req: express.Request; authLabel: string; isRoot: boolean }> => {
  if (!userSlug) {
    return {
      req: { remoteUser: undefined } as express.Request,
      authLabel: 'as guest',
      isRoot: false,
    };
  }

  const collective = await models.Collective.findBySlug(userSlug);
  if (!collective) {
    throw new Error(`Account not found: ${userSlug}`);
  }

  const user = await models.User.findOne({ where: { CollectiveId: collective.id } });
  if (!user) {
    throw new Error(`User not found for account: ${userSlug}`);
  }

  await user.populateRoles();

  return {
    req: { remoteUser: user } as express.Request,
    authLabel: `as @${userSlug}`,
    isRoot: user.isRoot(),
  };
};

const runBenchmarks = async (options: { limit: number; verbose: boolean; logSQL: boolean; user?: string }) => {
  const { req, authLabel, isRoot } = await resolveRequest(options.user);

  logger.info(`=== SQL search benchmark (limit=${options.limit}, ${authLabel}) ===`);

  for (const term of SEARCH_TERMS) {
    logger.info(`\n-- "${term}" --`);

    for (const caseDef of BENCHMARK_CASES) {
      const line = await runCase(req, caseDef, term, options.limit, isRoot, options.verbose, options.logSQL);
      logger.info(line);
    }
  }
};

const program = new Command();

program
  .name('benchmark-sql-search')
  .description('Benchmark searchCollectivesInDB with EXPLAIN ANALYZE stats')
  .option('--limit <n>', 'Page size', '100')
  .option('--verbose', 'Log full EXPLAIN ANALYZE output for page and count queries')
  .option('--logSQL', 'Log the SQL sent to PostgreSQL for page and count queries')
  .option('--user <accountSlug>', 'Run as an authenticated individual')
  .action(async cmdOptions => {
    const limit = parseInt(cmdOptions.limit, 10);
    if (isNaN(limit) || limit < 1) {
      throw new Error('--limit must be a positive integer');
    }

    await runBenchmarks({
      limit,
      verbose: Boolean(cmdOptions.verbose),
      logSQL: Boolean(cmdOptions.logSQL),
      user: cmdOptions.user,
    });
  });

if (!module.parent) {
  program
    .parseAsync(process.argv)
    .then(() => process.exit())
    .catch(error => {
      logger.error(error);
      process.exit(1);
    });
}
