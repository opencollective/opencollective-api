import createSubscriber from 'pg-listen';

import { getDBUrl } from '../db';
import logger from '../logger';
import { HandlerType, reportErrorToSentry } from '../sentry';
import sequelize from '../sequelize';

import { ElasticSearchModelsAdapters, getAdapterFromTableName } from './adapters';
import { ElasticSearchBatchProcessor } from './batch-processor';
import { getElasticSearchClient } from './client';
import { elasticSearchFullAccountReIndex } from './sync';
import { ElasticSearchRequest, ElasticSearchRequestPayload, ElasticSearchRequestType } from './types';

const CHANNEL_NAME = 'elasticsearch-requests';

const isRequestType = <T extends ElasticSearchRequestType>(request, type: T): request is ElasticSearchRequest<T> => {
  return Boolean(request && typeof request === 'object' && request.type === type);
};

let subscriber;

const setupPostgresTriggers = async () => {
  // TODO: Upgrade to postgres 14+ to use `CREATE OR REPLACE TRIGGER` instead of dropping and recreating the triggers
  await sequelize.query(`
    -- Create a trigger function to send notifications on table changes
    CREATE OR REPLACE FUNCTION notify_elasticsearch_on_change()
    RETURNS TRIGGER AS $$
    DECLARE
        notification JSON;
    BEGIN
        -- Determine the type of operation
        IF (TG_OP = 'INSERT') THEN
          notification = json_build_object('type', 'INSERT', 'table', TG_TABLE_NAME, 'payload', json_build_object('id', NEW.id));
        ELSIF (TG_OP = 'UPDATE') THEN
          notification = json_build_object('type', 'UPDATE',  'table', TG_TABLE_NAME, 'payload', json_build_object('id', NEW.id));
        ELSIF (TG_OP = 'DELETE') THEN
          notification = json_build_object('type', 'DELETE', 'table', TG_TABLE_NAME, 'payload', json_build_object('id', OLD.id));
        ELSIF (TG_OP = 'TRUNCATE') THEN
          notification = json_build_object('type', 'TRUNCATE', 'table', TG_TABLE_NAME, 'payload', json_build_object());
        END IF;

        -- Publish the notification to the Elastic Search requests channel
        PERFORM pg_notify('${CHANNEL_NAME}', notification::text);
        
        -- Return the appropriate row depending on the operation
        IF (TG_OP = 'DELETE') THEN
          RETURN OLD;
        ELSE
          RETURN NEW;
        END IF;
    END;
    $$ LANGUAGE plpgsql;

    ${Object.values(ElasticSearchModelsAdapters)
      .map(
        adapter => `
    -- TODO: Upgrade to postgres 14+ to use CREATE OR REPLACE TRIGGER instead of dropping and recreating the triggers
    DROP TRIGGER IF EXISTS ${adapter.model.tableName}_insert_trigger ON "${adapter.model.tableName}";
    DROP TRIGGER IF EXISTS ${adapter.model.tableName}_update_trigger ON "${adapter.model.tableName}";
    DROP TRIGGER IF EXISTS ${adapter.model.tableName}_delete_trigger ON "${adapter.model.tableName}";
    DROP TRIGGER IF EXISTS ${adapter.model.tableName}_truncate_trigger ON "${adapter.model.tableName}";

    -- Create the trigger for INSERT operations
    CREATE TRIGGER  ${adapter.model.tableName}_insert_trigger
    AFTER INSERT ON "${adapter.model.tableName}"
    FOR EACH ROW
    EXECUTE FUNCTION notify_elasticsearch_on_change();

    -- Create the trigger for UPDATE operations
    CREATE TRIGGER  ${adapter.model.tableName}_update_trigger
    AFTER UPDATE ON "${adapter.model.tableName}"
    FOR EACH ROW
    EXECUTE FUNCTION notify_elasticsearch_on_change();

    -- Create the trigger for DELETE operations
    CREATE TRIGGER  ${adapter.model.tableName}_delete_trigger
    AFTER DELETE ON "${adapter.model.tableName}"
    FOR EACH ROW
    EXECUTE FUNCTION notify_elasticsearch_on_change();

    -- Create the trigger for TRUNCATE operations
    CREATE TRIGGER  ${adapter.model.tableName}_truncate_trigger
    AFTER TRUNCATE ON "${adapter.model.tableName}"
    FOR EACH STATEMENT
    EXECUTE FUNCTION notify_elasticsearch_on_change();
  `,
      )
      .join('\n')}
  `);
};

const handleElasticSearchRequest = async (request: ElasticSearchRequest<ElasticSearchRequestType>) => {
  console.log('Received notification:', request);
  const client = getElasticSearchClient({ throwIfUnavailable: true });
  const adapter = getAdapterFromTableName(request.table);
  if (!adapter) {
    throw new Error(`No ElasticSearch adapter found for table ${request.table}`);
  }

  if (isRequestType(request, ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX)) {
    await elasticSearchFullAccountReIndex(request.payload.id);
  } else if (
    isRequestType(request, ElasticSearchRequestType.INSERT) ||
    isRequestType(request, ElasticSearchRequestType.UPDATE)
  ) {
    const [entry] = await adapter.findEntriesToIndex({ ids: [request.payload.id] });
    if (entry) {
      await client.bulk({
        index: adapter.index,
        body: [{ index: { _id: request.payload.id } }, adapter.mapModelInstanceToDocument(entry)],
      });
    }
  } else if (isRequestType(request, ElasticSearchRequestType.DELETE)) {
    await client.bulk({
      index: adapter.index,
      body: [{ delete: { _id: request.payload.id } }],
    });
  } else if (isRequestType(request, ElasticSearchRequestType.TRUNCATE)) {
    await client.deleteByQuery({
      index: adapter.index,
      body: { query: { match_all: {} } }, // eslint-disable-line camelcase
    });
  }
};

export const startElasticSearchPostgresSync = async () => {
  const elasticSearchBatchProcessor = ElasticSearchBatchProcessor.getInstance();
  subscriber = createSubscriber({ connectionString: getDBUrl('database') });

  subscriber.notifications.on(CHANNEL_NAME, async event => {
    try {
      // TODO: Check message format
      // TODO: Move to queue system:
      // await elasticSearchBatchProcessor.addToQueue(event);
      await handleElasticSearchRequest(event);
    } catch (error) {
      reportErrorToSentry(error, { handler: HandlerType.ELASTICSEARCH_SYNC_JOB });
    }
  });

  subscriber.events.on('error', error => {
    reportErrorToSentry(error, { handler: HandlerType.ELASTICSEARCH_SYNC_JOB });
  });

  process.on('exit', async () => {
    await elasticSearchBatchProcessor.flushAndClose();
    subscriber.close();
  });

  await subscriber.connect();
  await subscriber.listenTo(CHANNEL_NAME);

  await setupPostgresTriggers();

  logger.info('ElasticSearch <-> Postgres sync job started');
};

function buildElasticSearchRequest<T extends ElasticSearchRequestType>(
  type: T,
  payload: ElasticSearchRequestPayload[T],
) {
  return { type, payload };
}

export async function elasticSearchRequestFullAccountReIndex(collectiveId: number) {
  await subscriber.notify(
    CHANNEL_NAME,
    buildElasticSearchRequest(ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX, {
      id: collectiveId,
    }),
  );
}
