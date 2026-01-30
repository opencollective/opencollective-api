import { createPostgresListener, removePostgresTriggers, setupPostgresTriggers as setupTriggers } from '../db';
import logger from '../logger';
import { runWithTimeout } from '../promises';
import { HandlerType, reportErrorToSentry, reportMessageToSentry } from '../sentry';
import sequelize from '../sequelize';

import { OpenSearchModelsAdapters } from './adapters';
import { OpenSearchBatchProcessor } from './batch-processor';
import { isOpenSearchConfigured } from './client';
import { isValidOpenSearchRequest, OpenSearchRequestType } from './types';

const CHANNEL_NAME = 'opensearch-requests';
const FUNCTION_NAME = 'notify_opensearch_on_change';

const setupPostgresTriggers = async () => {
  const tables = Object.values(OpenSearchModelsAdapters).map(adapter => ({
    tableName: adapter.getModel().tableName,
    triggerPrefix: `search_${adapter.getModel().tableName}`,
  }));

  try {
    await setupTriggers(sequelize, CHANNEL_NAME, FUNCTION_NAME, tables);
  } catch (error) {
    logger.error(`Error setting up Postgres triggers: ${JSON.stringify(error)}`);
    reportErrorToSentry(error, { handler: HandlerType.OPENSEARCH_SYNC_JOB });
    throw new Error('Failed to setup Postgres triggers');
  }
};

export const removeOpenSearchPostgresTriggers = async () => {
  const tables = Object.values(OpenSearchModelsAdapters).map(adapter => ({
    tableName: adapter.getModel().tableName,
    triggerPrefix: `search_${adapter.getModel().tableName}`,
  }));

  await removePostgresTriggers(sequelize, FUNCTION_NAME, tables);
};

// Some shared variables
let shutdownPromise: Promise<void> | null = null;
let subscriber: ReturnType<typeof createPostgresListener>;

export const startOpenSearchPostgresSync = async () => {
  const openSearchBatchProcessor = OpenSearchBatchProcessor.getInstance();
  openSearchBatchProcessor.start();

  // Setup DB message queue
  subscriber = createPostgresListener();
  subscriber.notifications.on(CHANNEL_NAME, async event => {
    if (!isValidOpenSearchRequest(event)) {
      reportMessageToSentry('Invalid OpenSearch request', {
        extra: { event },
        handler: HandlerType.OPENSEARCH_SYNC_JOB,
        severity: 'error',
      });
      return;
    }

    try {
      openSearchBatchProcessor.addToQueue(event);
    } catch (error) {
      reportErrorToSentry(error, { handler: HandlerType.OPENSEARCH_SYNC_JOB });
    }
  });

  subscriber.events.on('error', error => {
    reportErrorToSentry(error, { handler: HandlerType.OPENSEARCH_SYNC_JOB });
  });

  await subscriber.connect();
  await subscriber.listenTo(CHANNEL_NAME);

  // Setup postgres triggers
  await setupPostgresTriggers();

  logger.info('OpenSearch <-> Postgres sync job started');

  return subscriber;
};

export const stopOpenSearchPostgresSync = (): Promise<void> => {
  if (!shutdownPromise) {
    logger.info('Shutting down OpenSearch <-> Postgres sync job');
    if (subscriber) {
      subscriber.close();
    }

    shutdownPromise = runWithTimeout(
      (async () => {
        await removeOpenSearchPostgresTriggers();
        const openSearchBatchProcessor = OpenSearchBatchProcessor.getInstance();
        await openSearchBatchProcessor.flushAndClose();
        logger.info('OpenSearch <-> Postgres sync job shutdown complete');
      })(),
      30_000,
      'OpenSearch <-> Postgres sync job took too long to shutdown, forcing exit',
    );
  }

  return shutdownPromise;
};

/**
 * Re-indexes all entries across all indexes related to this `collectiveId`, either through `CollectiveId`,
 * `HostCollectiveId`, `FromCollectiveId`...etc.
 */
export const openSearchFullAccountReIndex = async (collectiveId: number): Promise<void> => {
  if (!isOpenSearchConfigured()) {
    logger.debug(`OpenSearch is not configured, skipping ${collectiveId} full account re-index`);
    return;
  }

  OpenSearchBatchProcessor.getInstance().addToQueue({
    type: OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX,
    payload: { id: collectiveId },
  });
};
