/**
 * Prints the cost of GraphQL operations against the real V2 schema, with its weights and list sizes, and compares it
 * to the maximum of `config.graphql.cost.max`. See opencollective/opencollective#9084.
 *
 *     npm run graphql:cost -- <files or directories...> [options]
 *
 * Reads `.graphql` and `.gql` files (directories are read recursively). Fragments are shared between all the files.
 * The frontend CI writes its operations with `scripts/graphql-cost/extract-operations.ts` (frontend repository).
 *
 * Options:
 * - `--variables <file>`: JSON object of representative variables by operation name, used for the cost instead of
 *   the defaults: `{ "DashboardExpenses": { "limit": 20 } }`.
 * - `--baseline <file>`: JSON report of a previous run (`--json`), to list the operations whose cost changed.
 * - `--json <file>`: writes the report as JSON.
 * - `--markdown <file>`: writes the report as Markdown (for a GitHub job summary). Printed otherwise.
 * - `--fail`: exits with code 1 if an operation is over the maximum or cannot be analyzed, or if the input has
 *   problems. Without it, the command only reports (exit code 0).
 */
/* eslint-disable no-console */
import '../server/env';
// Models must be loaded before the schema
import '../server/models';

import fs from 'fs';
import path from 'path';

import { Command } from 'commander';

import {
  collectOperations,
  formatCostReportMarkdown,
  getCostReport,
  getOperationsOverMax,
} from '../server/graphql/cost/report';
import { getQueryCostSettings } from '../server/graphql/cost/settings';
import schemaV2 from '../server/graphql/v2/schema';

const GRAPHQL_EXTENSIONS = new Set(['.graphql', '.gql']);

type Options = {
  variables?: string;
  baseline?: string;
  json?: string;
  markdown?: string;
  heading?: string;
  fail?: boolean;
};

/** Reads the GraphQL files of `inputPath`. Sources are relative to the directory when given one. */
const readGraphQLFiles = (inputPath: string): { path: string; content: string }[] => {
  const stat = fs.statSync(inputPath);
  if (!stat.isDirectory()) {
    return [{ path: inputPath, content: fs.readFileSync(inputPath, 'utf8') }];
  }

  return (fs.readdirSync(inputPath, { recursive: true }) as string[])
    .filter(file => GRAPHQL_EXTENSIONS.has(path.extname(file)))
    .sort()
    .map(file => ({
      // `components/Foo.tsx.graphql`, as written by the frontend, is reported as `components/Foo.tsx`
      path: file.replace(/(\.[a-z]+)\.(graphql|gql)$/i, '$1'),
      content: fs.readFileSync(path.join(inputPath, file), 'utf8'),
    }));
};

const readJSON = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

const main = (inputPaths: string[], options: Options): number => {
  const files = inputPaths.flatMap(readGraphQLFiles);
  const { operations, errors } = collectOperations(files);
  const representativeVariables = options.variables ? readJSON(options.variables) : {};
  const { max } = getQueryCostSettings();
  const report = getCostReport(schemaV2, operations, { max, representativeVariables, errors });

  const baseline = options.baseline ? readJSON(options.baseline) : undefined;
  const markdown = formatCostReportMarkdown(report, { baseline, title: options.heading });
  if (options.markdown) {
    fs.writeFileSync(options.markdown, markdown);
  } else {
    console.log(markdown);
  }
  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify(report, null, 2));
  }

  const overMax = getOperationsOverMax(report);
  console.error(
    `${report.operations.length} operations, ${overMax.length} over the maximum of ${max}, ${report.errors.length} input problems`,
  );

  return options.fail && (overMax.length > 0 || report.errors.length > 0) ? 1 : 0;
};

const program = new Command()
  .description('Prints the cost of GraphQL operations against the V2 schema')
  .argument('<paths...>', 'GraphQL files or directories')
  .option('--variables <file>', 'JSON of representative variables, by operation name')
  .option('--baseline <file>', 'JSON report of a previous run, to list cost changes')
  .option('--json <file>', 'Write the report as JSON')
  .option('--markdown <file>', 'Write the report as Markdown instead of printing it')
  .option('--heading <heading>', 'Heading of the Markdown report')
  .option('--fail', 'Exit with code 1 when an operation is over the maximum, or the input has problems')
  .parse(process.argv);

try {
  process.exit(main(program.args, program.opts<Options>()));
} catch (error) {
  console.error(error);
  process.exit(2);
}
