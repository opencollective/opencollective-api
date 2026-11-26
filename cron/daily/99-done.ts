import '../../server/env';

import config from 'config';

import email from '../../server/lib/email';
import { HandlerType, reportErrorToSentry } from '../../server/lib/sentry';
import slackLib, { OPEN_COLLECTIVE_SLACK_CHANNEL } from '../../server/lib/slack';
import { runCronJob } from '../utils';

const recipients = 'ops@opencollective.com';

/**
 * Canary: sent whenever the daily jobs reach the end, even when some of them failed. Its absence
 * means the runner itself did not complete. The jobs that failed on the way are collected by
 * `scripts/cron.sh` (`CRON_FAILED_JOBS`) and listed here.
 */
export async function run(): Promise<void> {
  const failedJobs = (process.env.CRON_FAILED_JOBS || '').split(' ').filter(Boolean);

  if (!failedJobs.length) {
    const text = 'The Daily Cron Job successfully completed again today.';
    await email.sendMessage(recipients, 'Daily Cron Job completed', text, { text });
    return;
  }

  const text = `The Daily Cron Job completed today, but these jobs failed:\n\n${failedJobs.map(job => `- ${job}`).join('\n')}\n\nSee Sentry (handler: CRON) and the scheduler logs.`;
  if (config.slack.webhooks.engineeringAlerts) {
    try {
      await slackLib.postMessageToOpenCollectiveSlack(text, OPEN_COLLECTIVE_SLACK_CHANNEL.ENGINEERING_ALERTS);
    } catch (error) {
      reportErrorToSentry(error, { handler: HandlerType.CRON, extra: { failedJobs } });
    }
  }

  const html = text.replace(/\n/g, '<br>\n');
  await email.sendMessage(recipients, `Daily Cron Job completed, ${failedJobs.length} failed`, html, { text });
}

if (require.main === module) {
  runCronJob('done', run, 24 * 60 * 60);
}
