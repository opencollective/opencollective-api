#!/usr/bin/env ./node_modules/.bin/babel-node

/**
 * This script aims to provide a command-line interface to update transactions in a safe way.
 */

import '../../server/env';

import fs from 'fs';

import { Command } from 'commander';
import { capitalize, isNil, pickBy } from 'lodash';
// eslint-disable-next-line node/no-unpublished-import
import markdownTable from 'markdown-table';

/** Parse command-line arguments */
const getProgram = argv => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();

  // Misc options
  program.requiredOption('-i, --in <inputFile>', 'Input file');
  program.requiredOption('-o, --out <outputFile>', 'Output file');
  program.option('-b, --branch <branchName>', 'Branch name', 'current');
  program.option('-r, --reference <referenceFile>', 'Reference file');

  // Parse arguments
  program.parse(argv);
  return program;
};

type TableLine = [string, string, string, string];

const diffCount = (count, refCount): string => {
  if (isNil(refCount) || refCount === '') {
    return '-';
  } else if (count === refCount) {
    return '= ✅';
  } else if (count > refCount) {
    return `+${count - refCount} ✅`;
  } else {
    return `-${refCount - count} ❌`;
  }
};

const diffTime = (time, refTime): string => {
  if (isNil(refTime) || refTime === '') {
    return '-';
  } else if (time === refTime) {
    return '= ✅';
  } else if (time < refTime) {
    return `-${refTime - time} ✅`;
  } else {
    return `+${time - refTime} ❌`;
  }
};

const getLinesFromData = (data: Record<string, unknown>, referenceData: Record<string, unknown>): TableLine[] => {
  const lines: TableLine[] = [];

  // Get tests details
  lines.push(['**Test**', '', '', '']);
  const testPrefix = 'vusers.created_by_name.';
  const testsCounters = pickBy(data['aggregate']['counters'], (_, key) => key.startsWith(testPrefix));
  const referenceCounters = referenceData?.['aggregate']['counters'];
  Object.entries(testsCounters).forEach(([key, value]) => {
    const refValue = referenceCounters?.[key];
    lines.push([key.replace(testPrefix, ''), refValue || '-', value.toString(), diffCount(value, refValue)]);
  });

  // Separator
  lines.push(['', '', '', '']);

  // General stats
  const httpResponseTime = data['aggregate']['summaries']['http.response_time'];
  const referenceResponseTime = referenceData?.['aggregate']['summaries']['http.response_time'];
  lines.push(['**Global HTTP response times**', '', '', '']);
  lines.push(
    ...['min', 'max', 'median'].map((key: string): TableLine => {
      const refTime = referenceResponseTime?.[key];
      return [capitalize(key), refTime || '-', httpResponseTime[key], diffTime(httpResponseTime[key], refTime)];
    }),
  );

  return lines;
};

// Main
export const main = async (argv = process.argv) => {
  const program = getProgram(argv);
  const options = program.opts();

  // Load data
  const data = JSON.parse(fs.readFileSync(options.in, 'utf8'));
  let referenceData;
  try {
    referenceData = options.reference && JSON.parse(fs.readFileSync(options.reference, 'utf8'));
  } catch {
    console.log('Reference file not found, ignoring');
  }

  // Generate content
  const toCode = str => `\`${str}\``;
  const headers: TableLine = ['', toCode('main'), toCode(options['branch']), 'Diff'];
  const content: TableLine[] = getLinesFromData(data, referenceData);
  const prettyTable: string = markdownTable([headers, ...content]);
  fs.writeFileSync(
    options.out,
    `
## Performance

${prettyTable}

<details>

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

</details>
  `,
  );
};

// Only run script if called directly (to allow unit tests)
if (!module.parent) {
  main()
    .then(() => process.exit())
    .catch(e => {
      if (e.name !== 'CommanderError') {
        console.error(e);
      }

      process.exit(1);
    });
}
