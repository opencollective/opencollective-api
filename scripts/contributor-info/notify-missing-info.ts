/**
 * Manually emails contributors who reached a fiscal host's `CONTRIBUTOR_INFO_THRESHOLDS` without the matching
 * information on their profile. Same rules and dedup as `cron/daily/83-notify-contributors-missing-info.ts`, but
 * ignores its daily cap.
 *
 * Dry run by default: real queries, prints the report, sends nothing. Use `DRY_RUN=false` to send.
 *
 * Examples:
 *   npm run script scripts/contributor-info/notify-missing-info.ts -- --host some-host
 *   DRY_RUN=false npm run script scripts/contributor-info/notify-missing-info.ts -- --profile some-user --year 2026
 */

import '../../server/env';

import { Command } from 'commander';

import { CRON_NAME } from '../../cron/daily/83-notify-contributors-missing-info';
import { getYearsToProcess, notifyContributorsMissingInfo } from '../../server/lib/contributor-info-notify';
import logger from '../../server/lib/logger';
import { lockUntilOrThrow } from '../../server/lib/mutex';
import { Collective } from '../../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const collect = (value: string, previous: string[]) => [...previous, value];

const getIdsFromSlugs = async (slugs: string[]): Promise<number[]> => {
  if (!slugs.length) {
    return undefined;
  }

  const collectives = await Collective.findAll({ where: { slug: slugs }, attributes: ['id', 'slug'] });
  const missing = slugs.filter(slug => !collectives.some(c => c.slug === slug));
  if (missing.length) {
    throw new Error(`Accounts not found: ${missing.join(', ')}`);
  }

  return collectives.map(c => c.id);
};

const program = new Command()
  .option('--host <slug>', 'Only this host (repeatable)', collect, [])
  .option('--profile <slug>', 'Only this contributor profile (repeatable)', collect, [])
  .option('--year <yyyy>', 'Year to process (default: same years as the cron)', value => parseInt(value))
  .option('--limit <n>', 'Max recipients', value => parseInt(value))
  .option('--all', 'Allow a live run on all hosts and profiles without --limit')
  .option('--ignore-dedup', 'Send even if already requested (requires --profile)')
  .option('--json', 'Print the full report as JSON');

const main = async options => {
  if (options.ignoreDedup && !options.profile.length) {
    throw new Error('--ignore-dedup requires --profile');
  } else if (!DRY_RUN && !options.host.length && !options.profile.length && !options.limit && !options.all) {
    throw new Error('Live runs without --host or --profile require --limit or --all');
  }

  logger.info(`DRY_RUN: ${DRY_RUN}`);
  const run = async () =>
    notifyContributorsMissingInfo({
      years: options.year ? [options.year] : getYearsToProcess(),
      hostIds: await getIdsFromSlugs(options.host),
      profileIds: await getIdsFromSlugs(options.profile),
      limit: options.limit,
      dryRun: DRY_RUN,
      ignoreDedup: Boolean(options.ignoreDedup),
    });

  // Live runs share the cron lock, so the two never email the same profile at the same time
  const report = DRY_RUN ? await run() : await lockUntilOrThrow(`cron:${CRON_NAME}`, run, { unlockTimeoutMs: 3600e3 });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2)); // eslint-disable-line no-console
    return;
  }

  for (const profile of report.profiles) {
    const hosts = profile.hosts.map(h => `${h.hostId}/${h.year}: ${h.missingFields.join('+')} (${h.action})`);
    logger.info(`${profile.status.padEnd(11)} ${profile.slug} (#${profile.profileId}) → ${hosts.join(', ')}`);
  }
  for (const host of report.hosts) {
    logger.info(
      `Host ${host.slug}: ${host.candidates} candidates, ${host.deduped} deduped, ${host.requests} requests, ` +
        `${host.reminders} reminders, ${host.sent} ${DRY_RUN ? 'would send' : 'sent'}, ${host.leftOver} left over, ` +
        `${host.skipped} without recipient`,
    );
  }
  logger.info(`${report.recipients} recipients${DRY_RUN ? ' (dry run, nothing sent)' : ''}`);
};

if (!module.parent) {
  program
    .action(main)
    .parseAsync()
    .then(() => process.exit(0))
    .catch(e => {
      logger.error(e.toString());
      process.exit(1);
    });
}
