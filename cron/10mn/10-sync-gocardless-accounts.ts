import '../../server/env';

import debug from 'debug';
import { pick } from 'lodash';

import { GoCardlessRateLimitError, syncGoCardlessAccount } from '../../server/lib/gocardless/sync';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models, { Op } from '../../server/models';
import { TransactionsImportLockedError } from '../../server/models/TransactionsImport';
import { runCronJob } from '../utils';

// GoCardless only allows 4 successful transaction fetches per bank account per rolling 24h.
// Syncing every 8 hours uses at most 3 of them, keeping one in reserve for manual syncs.
// See https://github.com/opencollective/opencollective/issues/9175
const GOCARDLESS_REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000;

export const getGoCardlessImportsToSync = async (now = new Date()) => {
  return models.TransactionsImport.findAll({
    where: {
      type: 'GOCARDLESS',
      data: { lockedAt: null },
      lastSyncAt: {
        [Op.or]: [{ [Op.eq]: null }, { [Op.lt]: new Date(now.getTime() - GOCARDLESS_REFRESH_INTERVAL_MS) }],
      },
    },
    include: [
      {
        association: 'connectedAccount',
        required: true,
        where: {
          [Op.or]: [{ authorizationExpiresAt: { [Op.eq]: null } }, { authorizationExpiresAt: { [Op.gte]: now } }],
        },
      },
    ],
  });
};

const run = async () => {
  const importsToUpdate = await getGoCardlessImportsToSync();

  for (const importInstance of importsToUpdate) {
    try {
      await syncGoCardlessAccount(importInstance.connectedAccount, importInstance, {
        log: debug.enabled('gocardless'),
      });
    } catch (err) {
      if (err instanceof GoCardlessRateLimitError) {
        // All accounts are rate limited, they'll be retried once the limit resets
        continue;
      }

      reportErrorToSentry(err, {
        severity: err instanceof TransactionsImportLockedError ? 'warning' : 'error',
        extra: { importInstance: pick(importInstance, ['id', 'CollectiveId', 'ConnectedAccountId']) },
      });
    }
  }
};

if (require.main === module) {
  runCronJob('sync-gocardless-accounts', run, 10 * 60);
}
