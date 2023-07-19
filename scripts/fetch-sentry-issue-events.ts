/**
 * A script to fetch all the details from a Sentry issue.
 * Useful for debugging at scale.
 */

import fs from 'fs';

import { Command } from 'commander';
import fetch from 'node-fetch';

import { sleep } from '../server/lib/utils.js';

const fetchIssueEvents = (issueId: string, cursor: number) => {
  return fetch(`https://sentry.io/api/0/issues/${issueId}/events/?full=true&cursor=0:${cursor}:0`, {
    headers: {
      accept: 'application/json; charset=utf-8',
      authorization: `Bearer ${process.env.SENTRY_USER_TOKEN}`,
    },
    body: null,
    method: 'GET',
  }).then(response => (response.status === 200 ? response.json() : 'ERROR'));
};

const main = async (issueId: string, options) => {
  const allIssues = [];

  // Load existing file
  if (options['resume']) {
    try {
      const existing = JSON.parse(fs.readFileSync('sentry-result.json', 'utf8'));
      allIssues.push(...existing);
      console.log(`Loaded ${existing.length} events from sentry-result.json`);
    } catch (e) {
      console.error(`Error loading sentry-result.json:`, e);
    }
  }

  try {
    for (let i = allIssues.length; i < parseInt(options.limit); i += 100) {
      console.log(`Fetching ${i} to ${i + 100} events...`);
      const result = await fetchIssueEvents(issueId, i);
      if (!result.length) {
        console.log('No more events');
        break;
      }

      allIssues.push(...result);
      await sleep(1000);
    }
  } catch (e) {
    console.error(`Stopped in the loop:`, e);
  }

  if (allIssues.length) {
    console.log('Saving result to sentry-result.json');
    fs.writeFileSync('sentry-result.json', JSON.stringify(allIssues, null, 2));
  }
};

const program = new Command()
  .description('Helper to fetch the events of a Sentry issue')
  .option('--limit <number>', 'The number of events to fetch', parseInt, 10000)
  .option('--resume', 'Resume from the last cursor (based on sentry-result.json)', false)
  .argument('issueId')
  .parse();

main(program.args[0], program.opts());
