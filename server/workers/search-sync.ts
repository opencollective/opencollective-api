import config from 'config';

import { isOpenSearchConfigured } from '../lib/open-search/client';
import { startOpenSearchPostgresSync, stopOpenSearchPostgresSync } from '../lib/open-search/sync-postgres';
import { HandlerType, reportErrorToSentry } from '../lib/sentry';
import { parseToBoolean } from '../lib/utils';

import logger from './../lib/logger';

export async function startSearchSyncWorker() {
  if (!parseToBoolean(config.services.searchSync)) {
    return;
  }

  if (!isOpenSearchConfigured()) {
    logger.warn('OpenSearch is not configured. Skipping sync job.');
    return;
  }

  return startOpenSearchPostgresSync()
    .then(() => {
      const shutdown = async () => {
        await stopOpenSearchPostgresSync();
      };
      return shutdown;
    })
    .catch(e => {
      // We don't want to crash the server if the sync job fails to start
      logger.error('Failed to start OpenSearch sync worker', e);
      reportErrorToSentry(e, { handler: HandlerType.OPENSEARCH_SYNC_JOB });
    });
}
