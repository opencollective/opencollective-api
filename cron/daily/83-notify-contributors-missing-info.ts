/**
 * Emails contributors who reached a fiscal host's `CONTRIBUTOR_INFO_THRESHOLDS` without the matching information
 * (legal name, address) on their profile. See `server/lib/contributor-info-notify.ts`.
 *
 * `CONTRIBUTOR_MISSING_INFO_DAILY_EMAIL_LIMIT` caps the number of recipients per run. It defaults to 0, which
 * disables the job.
 */

import '../../server/env';

import { getYearsToProcess, notifyContributorsMissingInfo } from '../../server/lib/contributor-info-notify';
import logger from '../../server/lib/logger';
import { runCronJob } from '../utils';

/** Also used by the manual script, so both never run at the same time */
export const CRON_NAME = 'notify-contributors-missing-info';

const getDailyEmailLimit = (): number => {
  const limit = Number(process.env.CONTRIBUTOR_MISSING_INFO_DAILY_EMAIL_LIMIT);
  return Number.isInteger(limit) && limit > 0 ? limit : 0;
};

export const run = async () => {
  const limit = getDailyEmailLimit();
  if (!limit) {
    logger.info('CONTRIBUTOR_MISSING_INFO_DAILY_EMAIL_LIMIT is not set, skipping');
    return;
  }

  const years = getYearsToProcess();
  const report = await notifyContributorsMissingInfo({ years, limit, dryRun: false });
  logger.info(`Contributor info requests for ${years.join(', ')}: ${report.recipients} recipients (limit: ${limit})`);
  for (const host of report.hosts) {
    logger.info(
      `Host ${host.slug} (#${host.hostId}): ${host.candidates} candidates, ${host.deduped} deduped, ` +
        `${host.requests} requests, ${host.reminders} reminders, ${host.sent} sent, ${host.leftOver} left over, ` +
        `${host.skipped} without recipient`,
    );
  }

  return report;
};

if (require.main === module) {
  runCronJob(CRON_NAME, run, 60 * 60);
}
