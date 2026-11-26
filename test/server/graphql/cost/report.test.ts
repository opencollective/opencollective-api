import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from 'chai';
import {
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
} from 'graphql';
import { omit } from 'lodash';

import { getQueryCost } from '../../../../server/graphql/cost';
import { CostTier } from '../../../../server/graphql/cost/extensions';
import {
  collectOperations,
  compareWithBaseline,
  type CostReport,
  formatCostReportMarkdown,
  getCostReport,
  getOperationsOverMax,
} from '../../../../server/graphql/cost/report';
import schemaV2 from '../../../../server/graphql/v2/schema';

const API_ROOT = path.join(__dirname, '../../../..');
const FIXTURES = path.join(__dirname, 'fixtures');

/** A small schema where `Account.stats` declares `statsWeight` */
const buildSchema = ({ statsWeight = CostTier.Aggregate }: { statsWeight?: number } = {}) => {
  const Stats = new GraphQLObjectType({ name: 'Stats', fields: { total: { type: GraphQLInt } } });
  const Account: GraphQLObjectType = new GraphQLObjectType({
    name: 'Account',
    fields: () => ({
      id: { type: GraphQLID },
      stats: { type: Stats, extensions: { cost: { weight: statsWeight } } },
      children: {
        type: AccountCollection,
        args: { limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 10 } },
      },
    }),
  });
  const AccountCollection = new GraphQLObjectType({
    name: 'AccountCollection',
    fields: () => ({ totalCount: { type: GraphQLInt }, nodes: { type: new GraphQLList(Account) } }),
  });
  const Query = new GraphQLObjectType({
    name: 'Query',
    fields: {
      account: { type: Account, args: { slug: { type: GraphQLString } } },
      accounts: { type: AccountCollection, args: { limit: { type: GraphQLInt, defaultValue: 100 } } },
    },
  });
  return new GraphQLSchema({ query: Query });
};

/** The operations of a fixture frontend, as written by its extraction script */
const FRONTEND_FILES = [
  {
    path: 'components/AccountPage.tsx',
    // 1 (account) + 1 (id) + 100 (stats) + 1 (total)
    content: 'query AccountPage { account(slug: "a") { id stats { total } } }',
  },
  {
    path: 'components/AccountChildren.tsx',
    // 1 (account) + 10 (children) + 1 (totalCount) + 1 (nodes) + 5 × 1 (id)
    content:
      'query AccountChildren($limit: Int = 5) { account { children(limit: $limit) { totalCount nodes { id } } } }',
  },
  {
    path: 'components/AllAccounts.tsx',
    // 10 (accounts) + 1 (nodes) + 100 (schema default) × 102 (AccountFields)
    content: 'query AllAccounts($limit: Int) { accounts(limit: $limit) { nodes { ...AccountFields } } }',
  },
  {
    path: 'lib/fragments.ts',
    content: 'fragment AccountFields on Account { id stats { total } }',
  },
];

/** A frontend change that adds a query with nested limits */
const EXPENSIVE_QUERY_FILE = {
  path: 'components/Expensive.tsx',
  // 10 + 1 + 1,000 × (10 + 1 + 1,000 × (100 + 1))
  content:
    'query Expensive { accounts(limit: 1000) { nodes { children(limit: 1000) { nodes { stats { total } } } } } }',
};

const getReport = (
  files: { path: string; content: string }[],
  options: Partial<Parameters<typeof getCostReport>[2]> = {},
  schema = buildSchema(),
): CostReport => {
  const { operations, errors } = collectOperations(files);
  return getCostReport(schema, operations, { max: 1_000_000, errors, ...options });
};

const getCosts = (report: CostReport) =>
  Object.fromEntries(report.operations.map(operation => [operation.name, operation.cost]));

describe('server/graphql/cost/report', () => {
  describe('collectOperations', () => {
    it('shares fragments between files and includes only the ones each operation uses', () => {
      const { operations, errors } = collectOperations(FRONTEND_FILES);
      expect(errors).to.deep.eq([]);
      expect(operations.map(operation => [operation.name, operation.source])).to.deep.eq([
        ['AccountPage', 'components/AccountPage.tsx'],
        ['AccountChildren', 'components/AccountChildren.tsx'],
        ['AllAccounts', 'components/AllAccounts.tsx'],
      ]);
      expect(operations[0].document.definitions).to.have.length(1);
      expect(operations[2].document.definitions).to.have.length(2);
    });

    it('reports invalid documents, unnamed and duplicate operations, and missing fragments', () => {
      const { operations, errors } = collectOperations([
        { path: 'a.ts', content: 'query {' },
        { path: 'b.ts', content: '{ account { id } }' },
        { path: 'c.ts', content: 'query Same { account { id } }' },
        { path: 'd.ts', content: 'query Same { account { id } }' },
        { path: 'e.ts', content: 'query Partial { account { ...Missing } }' },
        { path: 'f.ts', content: 'fragment F on Account { id }' },
        { path: 'g.ts', content: 'fragment F on Account { stats { total } }' },
      ]);
      expect(operations.map(operation => operation.name)).to.deep.eq(['Same']);
      expect(errors).to.have.length(5);
      expect(errors[0]).to.match(/^a\.ts: Syntax Error/);
      expect(errors.slice(1)).to.deep.eq([
        'b.ts: operations must be named',
        'd.ts: operation "Same" is also defined in c.ts',
        'g.ts: fragment "F" is also defined differently in f.ts',
        'e.ts: operation "Partial" uses unknown fragments: Missing',
      ]);
    });
  });

  describe('formatCostReportMarkdown', () => {
    it('escapes the values written in table cells', () => {
      const report = getReport([{ path: 'a\\b|<c>.ts', content: 'query A { account { id } }' }]);
      expect(formatCostReportMarkdown(report)).to.contain('<sub>a\\\\b\\|&lt;c&gt;.ts</sub>');
    });
  });

  describe('getCostReport', () => {
    it('uses the variable defaults, then the schema defaults, most expensive first', () => {
      const report = getReport(FRONTEND_FILES);
      expect(report.errors).to.deep.eq([]);
      expect(report.operations.map(operation => [operation.name, operation.cost])).to.deep.eq([
        ['AllAccounts', 10_211],
        ['AccountPage', 103],
        ['AccountChildren', 18],
      ]);
    });

    it('reports the cost with every limit variable at the max limit, for information', () => {
      const report = getReport(FRONTEND_FILES);
      const byName = Object.fromEntries(report.operations.map(operation => [operation.name, operation]));
      expect(byName.AllAccounts.limitVariables).to.deep.eq(['limit']);
      expect(byName.AllAccounts.maxLimitCost).to.eq(10 + 1 + 1000 * 102);
      expect(byName.AccountChildren.maxLimitCost).to.eq(1 + 10 + 1 + 1 + 1000);
      expect(byName.AccountPage.limitVariables).to.deep.eq([]);
      expect(byName.AccountPage.maxLimitCost).to.eq(103);
    });

    it('uses the representative variables declared for an operation', () => {
      const report = getReport(FRONTEND_FILES, {
        representativeVariables: { AllAccounts: { limit: 10 }, Removed: { limit: 1 } },
      });
      const allAccounts = report.operations.find(operation => operation.name === 'AllAccounts');
      expect(allAccounts.cost).to.eq(10 + 1 + 10 * 102);
      expect(allAccounts.hasRepresentativeVariables).to.be.true;
      expect(allAccounts.maxLimitCost).to.eq(10 + 1 + 1000 * 102);
      expect(report.errors).to.deep.eq(['Representative variables are declared for an unknown operation: "Removed"']);
    });

    it('lists the fields that drive the cost', () => {
      const report = getReport([...FRONTEND_FILES, EXPENSIVE_QUERY_FILE]);
      expect(report.operations[0].name).to.eq('Expensive');
      expect(report.operations[0].topFields).to.deep.eq([
        { coordinate: 'Query.accounts', cost: 101_011_011 },
        { coordinate: 'Account.children', cost: 101_011_000 },
        { coordinate: 'Account.stats', cost: 101_000_000 },
      ]);
    });

    it('counts the fields of cached selections once per place they are used', () => {
      const result = getQueryCost(
        buildSchema(),
        parse(`
          query {
            a: accounts(limit: 2) { nodes { ...F } }
            b: accounts(limit: 3) { nodes { ...F } }
          }
          fragment F on Account { stats { total } }
        `),
        { breakdown: true },
      );
      expect(result.cost).to.eq(2 * (10 + 1) + 5 * 101);
      expect(result.breakdown).to.deep.eq([
        { coordinate: 'Query.accounts', cost: 2 * (10 + 1) + 5 * 101 },
        { coordinate: 'Account.stats', cost: 5 * 101 },
      ]);
      expect(getQueryCost(buildSchema(), parse('{ account { id } }')).breakdown).to.be.undefined;
    });

    it('counts operations that cannot be analyzed as over the maximum', () => {
      const deep = `query Deep { account { ${'children { nodes { '.repeat(60)} id ${'} } '.repeat(60)} } }`;
      const report = getReport([{ path: 'deep.ts', content: deep }]);
      expect(report.operations[0].cost).to.be.null;
      expect(report.operations[0].error).to.eq('Too large to analyze (MAX_DEPTH)');
      expect(getOperationsOverMax(report).map(operation => operation.name)).to.deep.eq(['Deep']);
    });
  });

  describe('frontend change that adds an expensive query', () => {
    it('reports the new operation over the maximum, and as a new operation compared to the baseline', () => {
      const baseline = getReport(FRONTEND_FILES);
      const report = getReport([...FRONTEND_FILES, EXPENSIVE_QUERY_FILE]);
      expect(getOperationsOverMax(baseline)).to.deep.eq([]);
      expect(getOperationsOverMax(report).map(operation => operation.name)).to.deep.eq(['Expensive']);
      expect(compareWithBaseline(report, baseline)).to.deep.eq([
        { name: 'Expensive', source: 'components/Expensive.tsx', before: null, after: 101_011_011, status: 'added' },
      ]);

      const markdown = formatCostReportMarkdown(report, { baseline });
      expect(markdown).to.contain('### Over the maximum (1)');
      expect(markdown).to.contain(
        '| `Expensive`<br><sub>components/Expensive.tsx</sub> | 101,011,011 | 10101% | 101,011,011 | `Query.accounts` 100%<br>`Account.children` 100%<br>`Account.stats` 100% |',
      );
      expect(markdown).to.contain('### Cost changes (1)');
      expect(markdown).to.contain('| `Expensive`<br><sub>components/Expensive.tsx</sub> | - | 101,011,011 | new |');
    });
  });

  describe('API change that raises a weight', () => {
    it('reports the operations whose cost changed, and the ones it pushes over the maximum', () => {
      const baseline = getReport(FRONTEND_FILES);
      const report = getReport(FRONTEND_FILES, {}, buildSchema({ statsWeight: 10_000 }));
      expect(getCosts(report)).to.deep.eq({ AllAccounts: 1_000_211, AccountPage: 10_003, AccountChildren: 18 });

      const changes = compareWithBaseline(report, baseline);
      expect(changes.map(change => [change.name, change.before, change.after])).to.deep.eq([
        ['AllAccounts', 10_211, 1_000_211],
        ['AccountPage', 103, 10_003],
      ]);

      const markdown = formatCostReportMarkdown(report, { baseline });
      expect(markdown).to.contain('### Over the maximum (1)');
      expect(markdown).to.contain('`Account.stats` 100%');
      const changesSection = markdown.slice(markdown.indexOf('### Cost changes'), markdown.indexOf('<details>'));
      expect(changesSection).to.contain('### Cost changes (2)');
      expect(changesSection).to.contain(
        '| `AllAccounts`<br><sub>components/AllAccounts.tsx</sub> | 10,211 | 1,000,211 | +9695% |',
      );
      expect(changesSection).to.contain(
        '| `AccountPage`<br><sub>components/AccountPage.tsx</sub> | 103 | 10,003 | +9612% |',
      );
      expect(changesSection).to.not.contain('AccountChildren');
    });
  });

  describe('scripts/graphql-cost.ts', function () {
    // Each run loads the whole V2 schema
    this.timeout(120_000);

    let tmpDir: string;
    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graphql-cost-'));
    });

    after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const run = (...args: string[]) =>
      spawnSync(
        path.join(API_ROOT, 'node_modules/.bin/babel-node'),
        ['--extensions', '.js,.ts', 'scripts/graphql-cost.ts', ...args],
        { cwd: API_ROOT, encoding: 'utf8', env: omit(process.env, ['GRAPHQL_COST_MAX']) },
      );

    it('returns the expected costs of the fixture documents against the V2 schema', () => {
      const jsonPath = path.join(tmpDir, 'report.json');
      const markdownPath = path.join(tmpDir, 'report.md');
      const result = run(path.join(FIXTURES, 'operations'), '--json', jsonPath, '--markdown', markdownPath, '--fail');
      expect(result.status, result.stderr).to.eq(0);

      const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      expect(report.max).to.eq(50_000_000);
      expect(report.errors).to.deep.eq([]);
      expect(report.operations.map(operation => [operation.name, operation.source, operation.cost])).to.deep.eq([
        // 1 (account) + 10 (transactions) + 1 (totalCount) + 1 (nodes) + 20 × (1 (id) + 1 (amount) + 2)
        ['FixtureTransactions', 'Transactions.graphql', 93],
        // 1 (account) + 1 (id) + 1 (name) + 10 (members) + 1 (totalCount) + 1 (nodes) + 10 × 2
        ['FixtureAccountPage', 'AccountPage.graphql', 35],
      ]);

      // Same as computing it in-process
      const files = ['AccountPage.graphql', 'Transactions.graphql', 'fragments.graphql'].map(file => ({
        path: file,
        content: fs.readFileSync(path.join(FIXTURES, 'operations', file), 'utf8'),
      }));
      const { operations } = collectOperations(files);
      expect(getCosts(getCostReport(schemaV2, operations, { max: 50_000_000 }))).to.deep.eq({
        FixtureTransactions: 93,
        FixtureAccountPage: 35,
      });
      expect(fs.readFileSync(markdownPath, 'utf8')).to.contain('### Over the maximum (0)');
    });

    it('exits with a non-zero code in failing mode when an operation is over the maximum', () => {
      const inputs = [path.join(FIXTURES, 'operations'), path.join(FIXTURES, 'over-max')];
      const reportOnly = run(...inputs, '--markdown', path.join(tmpDir, 'report.md'));
      expect(reportOnly.status, reportOnly.stderr).to.eq(0);
      expect(fs.readFileSync(path.join(tmpDir, 'report.md'), 'utf8')).to.match(
        /### Over the maximum \(1\)\n\n.*\n.*\n\| `FixtureExpensive`/,
      );

      const failing = run(...inputs, '--markdown', path.join(tmpDir, 'report.md'), '--fail');
      expect(failing.status).to.eq(1);
      expect(failing.stderr).to.contain('3 operations, 1 over the maximum of 50000000');
    });
  });
});
