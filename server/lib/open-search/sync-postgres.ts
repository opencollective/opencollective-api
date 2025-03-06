import { createPostgresListener } from '../db';
import logger from '../logger';
import { runWithTimeout } from '../promises';
import { HandlerType, reportErrorToSentry, reportMessageToSentry } from '../sentry';
import sequelize from '../sequelize';

import { OpenSearchModelsAdapters } from './adapters';
import { OpenSearchBatchProcessor } from './batch-processor';
import { isOpenSearchConfigured } from './client';
import { isValidOpenSearchRequest, OpenSearchRequestType } from './types';

const CHANNEL_NAME = 'opensearch-requests';

const setupPostgresTriggers = async () => {
  try {
    await sequelize.query(`
      -- Create a trigger function to send notifications on table changes
      CREATE OR REPLACE FUNCTION notify_opensearch_on_change()
      RETURNS TRIGGER AS $$
      DECLARE
          notification JSON;
      BEGIN
          -- Determine the type of operation
          IF (TG_OP = 'INSERT') THEN
            notification = json_build_object('type', 'UPDATE',  'table', TG_TABLE_NAME, 'payload', json_build_object('id', NEW.id));
          ELSIF (TG_OP = 'UPDATE') THEN
            IF (OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL) THEN
              notification = json_build_object('type', 'DELETE', 'table', TG_TABLE_NAME, 'payload', json_build_object('id', NEW.id));
            ELSIF (OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS NOT NULL) THEN
              RETURN NULL; -- Do not notify on updates of deleted rows
            ELSE
              notification = json_build_object('type', 'UPDATE', 'table', TG_TABLE_NAME, 'payload', json_build_object('id', NEW.id));
            END IF;
          ELSIF (TG_OP = 'DELETE') THEN
            notification = json_build_object('type', 'DELETE', 'table', TG_TABLE_NAME, 'payload', json_build_object('id', OLD.id));
          END IF;
  
          -- Publish the notification to the search requests channel
          PERFORM pg_notify('${CHANNEL_NAME}', notification::text);
  
          RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
  
      ${Object.values(OpenSearchModelsAdapters)
        .map(
          adapter => `
      -- Create the trigger for INSERT operations
      CREATE OR REPLACE TRIGGER  ${adapter.getModel().tableName}_insert_trigger
      AFTER INSERT ON "${adapter.getModel().tableName}"
      FOR EACH ROW
      EXECUTE FUNCTION notify_opensearch_on_change();
  
      -- Create the trigger for UPDATE operations
      CREATE OR REPLACE TRIGGER  ${adapter.getModel().tableName}_update_trigger
      AFTER UPDATE ON "${adapter.getModel().tableName}"
      FOR EACH ROW
      EXECUTE FUNCTION notify_opensearch_on_change();
  
      -- Create the trigger for DELETE operations
      CREATE OR REPLACE TRIGGER  ${adapter.getModel().tableName}_delete_trigger
      AFTER DELETE ON "${adapter.getModel().tableName}"
      FOR EACH ROW
      EXECUTE FUNCTION notify_opensearch_on_change();
    `,
        )
        .join('\n')}
    `);
  } catch (error) {
    logger.error(`Error setting up Postgres triggers: ${JSON.stringify(error)}`);
    reportErrorToSentry(error, { handler: HandlerType.OPENSEARCH_SYNC_JOB });
    throw new Error('Failed to setup Postgres triggers');
  }
};

export const removeOpenSearchPostgresTriggers = async () => {
  await sequelize.query(`
    ${Object.values(OpenSearchModelsAdapters)
      .map(
        adapter => `
    DROP TRIGGER IF EXISTS ${adapter.getModel().tableName}_insert_trigger ON "${adapter.getModel().tableName}";
    DROP TRIGGER IF EXISTS ${adapter.getModel().tableName}_update_trigger ON "${adapter.getModel().tableName}";
    DROP TRIGGER IF EXISTS ${adapter.getModel().tableName}_delete_trigger ON "${adapter.getModel().tableName}";
    DROP TRIGGER IF EXISTS ${adapter.getModel().tableName}_truncate_trigger ON "${adapter.getModel().tableName}";
  `,
      )
      .join('\n')}

    DROP FUNCTION IF EXISTS notify_opensearch_on_change();
  `);
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

setTimeout(() => {
  openSearchFullAccountReIndex(1);
}, 5000);
