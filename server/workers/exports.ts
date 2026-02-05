import config from 'config';

import ExportWorker from '../lib/export-requests/worker';
import logger from '../lib/logger';
import { HandlerType, reportErrorToSentry } from '../lib/sentry';
import { parseToBoolean } from '../lib/utils';

export async function startExportWorker() {
  // Set ENABLE_SERVICE_EXPORTS env variable to true to enable the exports worker
  if (!parseToBoolean(config.services.exports)) {
    return;
  }

  return ExportWorker.start()
    .then(() => {
      const shutdown = async () => {
        await ExportWorker.stop();
      };
      return shutdown;
    })
    .catch(e => {
      // We don't want to crash the server if the sync job fails to start
      logger.error('Failed to start exports worker', e);
      reportErrorToSentry(e, { handler: HandlerType.EXPORTS_WORKER });
    });
}
