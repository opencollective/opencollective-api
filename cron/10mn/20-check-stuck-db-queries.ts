import '../../server/env';

import { QueryTypes } from 'sequelize';

import logger from '../../server/lib/logger';
import { HandlerType, reportErrorToSentry } from '../../server/lib/sentry';
import slackLib, { OPEN_COLLECTIVE_SLACK_CHANNEL } from '../../server/lib/slack';
import { sequelize } from '../../server/models';
import { runCronJob } from '../utils';

const STUCK_QUERY_THRESHOLD_MINUTES = process.env.STUCK_QUERY_THRESHOLD_MINUTES
  ? parseInt(process.env.STUCK_QUERY_THRESHOLD_MINUTES)
  : 3;

type StuckQuery = {
  pid: number;
  user: string;
  query_start: Date;
  query_time: string;
  query: string;
  state: string;
  wait_event_type: string | null;
  wait_event: string | null;
};

async function run() {
  const stuckQueries = await sequelize.query<StuckQuery>(
    `
    SELECT
      pid,
      user,
      pg_stat_activity.query_start,
      (now() - pg_stat_activity.query_start)::varchar AS query_time,
      query,
      state,
      wait_event_type,
      wait_event
    FROM pg_stat_activity
    WHERE (now() - pg_stat_activity.query_start) > (:threshold * interval '1 minute')
    AND query NOT IN (
      'SHOW TRANSACTION ISOLATION LEVEL',
      E'SHOW extwlist.extensions\n;',
      'SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED'
    )
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

  logger.warn(
    `Found ${stuckQueries.length} stuck query(ies) running for more than ${STUCK_QUERY_THRESHOLD_MINUTES} minutes.`,
  );

  const lines: string[] = [
    `:warning: *${stuckQueries.length} stuck DB query(ies)* running for more than ${STUCK_QUERY_THRESHOLD_MINUTES} minutes:`,
    '',
  ];

  for (const q of stuckQueries) {
    lines.push(
      [
        `*PID:* ${q.pid} | *User:* ${q.user} | *State:* ${q.state} | *Running for:* ${q.query_time}`,
        q.wait_event_type ? `*Wait:* ${q.wait_event_type} / ${q.wait_event}` : null,
        `\`\`\`${q.query.substring(0, 500)}${q.query.length > 500 ? '…' : ''}\`\`\``,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  try {
    await slackLib.postMessageToOpenCollectiveSlack(lines.join('\n'), OPEN_COLLECTIVE_SLACK_CHANNEL.ENGINEERING_ALERTS);
  } catch (error) {
    reportErrorToSentry(error, { handler: HandlerType.CRON, extra: { stuckQueries } });
  }
}

if (require.main === module) {
  runCronJob('check-stuck-db-queries', run, 10 * 60);
}
