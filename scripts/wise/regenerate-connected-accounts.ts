/**
 * Regenerates Wise ConnectedAccounts `data` from the Wise API and repopulates the `personalProfile`
 * that older connections are missing.
 *
 * Some TransferWise accounts were persisted before we started storing the personal profile. Without
 * `data.personalProfile.userId`, scripts such as `scripts/wise/backfill-connected-account-hashes.ts`
 * cannot recompute the account `hash`, because that `userId` is only available from Wise. This script
 * fills that gap: it uses each account's token (refreshing it when needed) to fetch the profiles from
 * Wise and re-persists the business + personal profiles onto the connected account.
 *
 * Mirrored connected accounts are ignored: they do not own credentials (`token` is null and they
 * point to a source account through `data.MirrorConnectedAccountId`). The source account is processed
 * on its own.
 *
 * The account `hash` depends on which profile of type `PERSONAL` is picked, so before writing anything
 * we assert that Wise returns exactly one personal profile for the given token. Accounts that don't
 * satisfy this are reported and, if any, make the script exit with a non-zero status.
 *
 * Run with:
 *   npm run script scripts/wise/regenerate-connected-accounts.ts -- [--limit 100] [--all]
 * Dry-run by default; pass DRY_RUN=false to apply.
 */

import '../../server/env';

import assert from 'assert';

import { Command } from 'commander';

import { Service } from '../../server/constants/connected-account';
import logger from '../../server/lib/logger';
import * as transferwiseLib from '../../server/lib/transferwise';
import models, { ConnectedAccount, sequelize } from '../../server/models';
import { hashObject } from '../../server/paymentProviders/utils';
import { PersonalProfileV2, ProfileV2 } from '../../server/types/transferwise';

const DRY_RUN = process.env.DRY_RUN !== 'false';

type RegenerateSummary = {
  scanned: number;
  regenerated: number;
  skippedMirror: number;
  skippedWithoutToken: number;
  skippedAlreadyPopulated: number;
  failed: number;
  errors: { connectedAccountId: number; message: string }[];
  isDryRun: boolean;
};

const isMirroredAccount = (account: ConnectedAccount): boolean =>
  Boolean(account.settings?.isMirror || account.data?.MirrorConnectedAccountId);

/**
 * Fetches the Wise profiles for the account token, asserts there is a single PERSONAL profile and
 * returns the regenerated `data`/`settings`/`hash` values to persist.
 */
const buildRegeneratedAccount = async (
  account: ConnectedAccount,
): Promise<{ data: Record<string, unknown>; settings: Record<string, unknown>; hash: string }> => {
  const profiles: ProfileV2[] = await transferwiseLib.getProfiles(account);

  const personalProfiles = profiles.filter((p): p is PersonalProfileV2 => p.type === 'PERSONAL');
  assert.strictEqual(
    personalProfiles.length,
    1,
    `Expected exactly one PERSONAL Wise profile for connected account #${account.id}, got ${personalProfiles.length}`,
  );
  const personalProfile = personalProfiles[0];

  const profileId = account.data?.id;
  assert(profileId, `Connected account #${account.id} is missing data.id`);
  const businessProfile = profiles.find(p => String(p.id) === String(profileId));
  assert(businessProfile, `Could not find Wise profile ${profileId} for connected account #${account.id}`);

  const data = { ...account.data, ...businessProfile, personalProfile };
  const hash = hashObject({
    profileId: businessProfile.id,
    service: Service.TRANSFERWISE,
    userId: personalProfile.userId,
  });
  const settings = {
    ...account.settings,
    isOwner: businessProfile.type === 'BUSINESS' && businessProfile.companyRole === 'OWNER',
    userId: personalProfile.userId,
  };

  return { data, settings, hash };
};

export const regenerateConnectedAccounts = async ({
  isDryRun,
  limit,
  all = false,
}: {
  isDryRun: boolean;
  limit?: number;
  all?: boolean;
}): Promise<RegenerateSummary> => {
  const summary: RegenerateSummary = {
    scanned: 0,
    regenerated: 0,
    skippedMirror: 0,
    skippedWithoutToken: 0,
    skippedAlreadyPopulated: 0,
    failed: 0,
    errors: [],
    isDryRun,
  };

  const accounts = await models.ConnectedAccount.findAll({
    // Filter `deletedAt` explicitly rather than relying on the paranoid scope: soft-deleted accounts
    // must never be rewritten.
    where: { service: Service.TRANSFERWISE, deletedAt: null },
    order: [['id', 'ASC']],
    ...(limit ? { limit } : {}),
  });

  for (const account of accounts) {
    summary.scanned++;

    if (isMirroredAccount(account)) {
      summary.skippedMirror++;
      continue;
    }

    // Mirrors are tokenless; any other tokenless account cannot be fetched from Wise.
    if (!account.token && !account.refreshToken) {
      summary.skippedWithoutToken++;
      continue;
    }

    if (!all && account.data?.personalProfile?.userId) {
      summary.skippedAlreadyPopulated++;
      continue;
    }

    try {
      const { data, settings, hash } = await buildRegeneratedAccount(account);
      summary.regenerated++;
      if (!isDryRun) {
        await account.update({ data, settings, hash });
      }
    } catch (e) {
      summary.failed++;
      summary.errors.push({ connectedAccountId: account.id, message: e.message });
      logger.error(`Failed to regenerate Wise connected account #${account.id}: ${e.message}`);
    }
  }

  return summary;
};

const program = new Command();
program
  .description('Regenerate Wise ConnectedAccounts data and repopulate the missing personalProfile')
  .option('--limit <number>', 'Limit the number of connected accounts to process', parseInt)
  .option('--all', 'Regenerate every non-mirrored account, even those that already have a personalProfile')
  .action(async options => {
    assert(
      options.limit === undefined || (Number.isInteger(options.limit) && options.limit > 0),
      'The --limit option must be a positive integer',
    );
    console.log(`Starting Wise connected-account regeneration (DRY_RUN: ${DRY_RUN}, all: ${Boolean(options.all)})...`);
    const summary = await regenerateConnectedAccounts({ isDryRun: DRY_RUN, limit: options.limit, all: options.all });
    console.log(`Summary: ${JSON.stringify(summary)}`);
    await sequelize.close();
    if (summary.failed > 0) {
      process.exit(1);
    }
  });

if (!module.parent) {
  program
    .parseAsync()
    .then(() => {
      process.exit(0);
    })
    .catch(e => {
      logger.error(e.toString());
      process.exit(1);
    });
}
