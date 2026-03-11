/**
 * A CRON job to check for stuck DB queries.
 *
 * Dev hint: you can simulate a stuck query by running:
 * ```
 * SELECT pg_sleep(5000);
 * ```
 */

import '../../server/env';

import { truncate } from 'lodash';
import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { HandlerType, reportErrorToSentry } from '../../server/lib/sentry';
import slackLib, { OPEN_COLLECTIVE_SLACK_CHANNEL } from '../../server/lib/slack';
import { parseToBoolean } from '../../server/lib/utils';
import { sequelize } from '../../server/models';
import { runCronJob } from '../utils';

const PRINT_TO_LOCAL = parseToBoolean(process.env.PRINT_TO_LOCAL);
const STUCK_QUERY_THRESHOLD_SECONDS = process.env.STUCK_QUERY_THRESHOLD_SECONDS
  ? parseInt(process.env.STUCK_QUERY_THRESHOLD_SECONDS)
  : 3 * 30;

type StuckQueryGroup = {
  pids: number[];
  user: string;
  application_name: string | null;
  count: number;
  query: string;
  longest_run: string;
};

const postOnSlack = async (str: string) => {
  if (PRINT_TO_LOCAL) {
    logger.info(str);
    return;
  }

  try {
    await slackLib.postMessageToOpenCollectiveSlack(str, OPEN_COLLECTIVE_SLACK_CHANNEL.ENGINEERING_ALERTS);
  } catch (error) {
    reportErrorToSentry(error, { handler: HandlerType.CRON, extra: { str } });
  }
};

const formatStuckQueryGroup = (g: StuckQueryGroup): string => {
  const numPids = g.pids.length;
  return [
    [
      `*PIDs:* ${g.pids.map(pid => `\`${pid}\``).join(', ')}`,
      `*User:* \`${g.user}\``,
      g.application_name ? `*App:* \`${g.application_name}\`` : null,
      g.count > 1 ? `*Duplicate queries:* ${g.count}` : null,
      `*${numPids > 1 ? 'Longest run' : 'Run'} duration:* \`${g.longest_run}\``,
    ]
      .filter(Boolean)
      .join(' | '),
    `\`\`\`${truncate(g.query, { length: 30_000 })}\`\`\``,
  ].join('\n');
};

async function run() {
  const stuckQueries = await sequelize.query<StuckQueryGroup>(
    `
    SELECT
      array_agg(pid ORDER BY query_start) AS pids,
      usename AS "user",
      application_name,
      count(*)::int AS count,
      query,
      max(now() - query_start)::varchar AS longest_run
    FROM pg_stat_activity
    WHERE state = 'active'
    AND application_name != 'Heroku Postgres Backups'
    AND (now() - query_start) > (:threshold * interval '1 second')
    AND query NOT IN (
      'SHOW TRANSACTION ISOLATION LEVEL',
      E'SHOW extwlist.extensions\n;',
      'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED'
    )
    GROUP BY usename, application_name, query
    ORDER BY max(now() - query_start) DESC
    `,
    {
      raw: true,
      type: QueryTypes.SELECT,
      replacements: { threshold: STUCK_QUERY_THRESHOLD_SECONDS },
    },
  );

  if (!stuckQueries.length) {
    logger.info('No stuck queries found.');
    return;
  }

  const totalQueries = stuckQueries.reduce((sum, g) => sum + g.count, 0);
  const numGroups = stuckQueries.length;
  const distinctLabel = numGroups < totalQueries ? ` (${numGroups} distinct)` : '';

  logger.warn(`Found ${totalQueries} stuck query(ies) running for more than ${STUCK_QUERY_THRESHOLD_SECONDS} seconds.`);

  const summary = `:warning: *${totalQueries} stuck DB query(ies)*${distinctLabel} running for more than ${STUCK_QUERY_THRESHOLD_SECONDS} seconds:`;
  if (numGroups === 1) {
    await postOnSlack(`${summary}\n${formatStuckQueryGroup(stuckQueries[0])}`);
  } else {
    await postOnSlack(summary);
    for (const g of stuckQueries) {
      await postOnSlack(formatStuckQueryGroup(g));
    }
  }
}

if (require.main === module) {
  runCronJob('check-stuck-db-queries', run, 10 * 60);
}
