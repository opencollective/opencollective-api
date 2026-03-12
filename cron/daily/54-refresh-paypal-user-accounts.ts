/**
 * Daily CRON job to refresh PayPal user identity information for payees who have connected their
 * PayPal accounts via OAuth. This ensures that hosts always see up-to-date account information
 * (name, email, verification status) and helps detect disconnected or changed accounts.
 *
 * Accounts that were verified more than REFRESH_AFTER_DAYS days ago are refreshed.
 * Accounts where the refresh fails (e.g., token revoked) are flagged by clearing `data.verified`.
 *
 * See: https://github.com/opencollective/opencollective/issues/8382
 */

import '../../server/env';

import moment from 'moment';
import { Op } from 'sequelize';

import logger from '../../server/lib/logger';
import { refreshPaypalUserAccount } from '../../server/lib/paypal';
import { HandlerType, reportErrorToSentry } from '../../server/lib/sentry';
import { ConnectedAccount } from '../../server/models';
import { runCronJob } from '../utils';

/** Refresh accounts that haven't been updated in this many days */
const REFRESH_AFTER_DAYS = Number(process.env.REFRESH_AFTER_DAYS) || 7;
const DRY_RUN = process.env.DRY_RUN === 'true';
const BATCH_SIZE = 50;

const run = async () => {
  const cutoff = moment.utc().subtract(REFRESH_AFTER_DAYS, 'days').toDate();

  // Find user-level PayPal ConnectedAccounts (those without a clientId are user-level, not host-level)
  const accounts = await ConnectedAccount.findAll({
    where: {
      service: 'paypal',
      clientId: null,
      refreshToken: { [Op.not]: null },
      updatedAt: { [Op.lt]: cutoff },
    },
    order: [['updatedAt', 'ASC']],
    limit: BATCH_SIZE,
  });

  logger.info(
    `Found ${accounts.length} PayPal user ConnectedAccount(s) due for refresh (last updated before ${cutoff.toISOString()})`,
  );

  if (DRY_RUN) {
    logger.info('[DRY_RUN] Would refresh the above accounts. Exiting.');
    return;
  }

  let refreshed = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const result = await refreshPaypalUserAccount(account);
      if (result) {
        refreshed++;
        logger.debug(`Refreshed PayPal ConnectedAccount #${account.id} (Collective #${account.CollectiveId})`);
      } else {
        failed++;
        // refreshPaypalUserAccount returned null — mark as not verified so the payee is prompted to reconnect
        await account.update({
          data: {
            ...account.data,
            verified: false,
            refreshFailedAt: new Date().toISOString(),
          },
        });
        logger.warn(
          `Failed to refresh PayPal ConnectedAccount #${account.id} (Collective #${account.CollectiveId}) — marked as unverified`,
        );
      }
    } catch (err) {
      failed++;
      logger.error(`Error refreshing PayPal ConnectedAccount #${account.id}: ${err.message}`);
      reportErrorToSentry(err, {
        handler: HandlerType.CRON,
        extra: { connectedAccountId: account.id, collectiveId: account.CollectiveId },
      });
    }
  }

  logger.info(
    `PayPal user account refresh complete: ${refreshed} refreshed, ${failed} failed out of ${accounts.length} accounts`,
  );
};

if (require.main === module) {
  runCronJob('refresh-paypal-user-accounts', run, 24 * 60 * 60);
}
