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
const STUCK_QUERY_THRESHOLD_MINUTES = process.env.STUCK_QUERY_THRESHOLD_MINUTES
  ? parseInt(process.env.STUCK_QUERY_THRESHOLD_MINUTES)
  : 5;

type StuckQueryGroup = {
  pids: number[];
  user: string;
  application_name: string | null;
  count: number;
  query: string;
  states: (string | null)[];
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
  const stateCounts = g.states.reduce(
    (acc, s) => {
      const key = s ?? 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const statesStr = Object.entries(stateCounts)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');

  return [
    [
      `*PIDs:* ${g.pids.map(pid => `\`${pid}\``).join(', ')}`,
      `*User:* \`${g.user}\``,
      g.application_name ? `*App:* \`${g.application_name}\`` : null,
      g.count > 1 ? `*Duplicate queries:* ${g.count}` : null,
      `*States:* ${statesStr}`,
      `*${numPids > 1 ? 'Longest run' : 'Run'} duration:* ${g.longest_run}`,
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
      array_agg(state ORDER BY state) AS states,
      max(now() - query_start)::varchar AS longest_run
    FROM pg_stat_activity
    WHERE (now() - query_start) > (:threshold * interval '1 minute')
    AND query NOT IN (
      'SHOW TRANSACTION ISOLATION LEVEL',
      E'SHOW extwlist.extensions\n;',
      'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED'
    )
    AND query NOT LIKE '%pg_backup_start%'
    GROUP BY usename, application_name, query
    ORDER BY max(now() - query_start) DESC
    `,
    {
      raw: true,
      type: QueryTypes.SELECT,
      replacements: { threshold: STUCK_QUERY_THRESHOLD_MINUTES },
    },
  );

  if (!stuckQueries.length) {
    logger.info('No stuck queries found.');
    return;
  }

  const totalQueries = stuckQueries.reduce((sum, g) => sum + g.count, 0);
  const numGroups = stuckQueries.length;
  const distinctLabel = numGroups < totalQueries ? ` (${numGroups} distinct)` : '';

  logger.warn(`Found ${totalQueries} stuck query(ies) running for more than ${STUCK_QUERY_THRESHOLD_MINUTES} minutes.`);

  const summary = `:warning: *${totalQueries} stuck DB query(ies)*${distinctLabel} running for more than ${STUCK_QUERY_THRESHOLD_MINUTES} minutes:`;
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
