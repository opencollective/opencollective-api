import '../../server/env';

import { isAxiosError } from 'axios';
import debug from 'debug';
import { pick } from 'lodash';

import { syncGoCardlessAccount } from '../../server/lib/gocardless/sync';
import { reportErrorToSentry } from '../../server/lib/sentry';
import models, { Op } from '../../server/models';
import { TransactionsImportLockedError } from '../../server/models/TransactionsImport';
import { runCronJob } from '../utils';

// Every 60 minutes
const refreshIntervalMs = 60 * 60 * 1000;

export const getGoCardlessImportsToSync = async (now = new Date()) => {
  return models.TransactionsImport.findAll({
    where: {
      type: 'GOCARDLESS',
      data: { lockedAt: null },
      lastSyncAt: {
        [Op.or]: [{ [Op.eq]: null }, { [Op.lt]: new Date(now.getTime() - refreshIntervalMs) }],
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
      if (isAxiosError(err) && err.response?.status === 429) {
        // Ignore rate limit errors
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
