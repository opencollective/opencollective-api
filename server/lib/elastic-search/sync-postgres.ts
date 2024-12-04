import createSubscriber from 'pg-listen';

import { getDBUrl } from '../db';
import logger from '../logger';
import { HandlerType, reportErrorToSentry } from '../sentry';
import sequelize from '../sequelize';

import { ElasticSearchModelsAdapters } from './adapters';
import { ElasticSearchBatchProcessor } from './batch-processor';

const CHANNEL_NAME = 'elasticsearch-requests';

const setupPostgresTriggers = async () => {
  await sequelize.query(`
    -- Create a trigger function to send notifications on table changes
    CREATE OR REPLACE FUNCTION notify_elasticsearch_on_change()
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
          ESLIF (TG_TABLE_NAME = 'Collectives' AND OLD."HostCollectiveId" IS DISTINCT FROM NEW."HostCollectiveId") THEN
            notification = json_build_object('type', 'FULL_ACCOUNT_RE_INDEX', 'payload', json_build_object('id', NEW.id));
          ELSE
            notification = json_build_object('type', 'UPDATE', 'table', TG_TABLE_NAME, 'payload', json_build_object('id', NEW.id));
          END IF;
        ELSIF (TG_OP = 'DELETE') THEN
          notification = json_build_object('type', 'DELETE', 'table', TG_TABLE_NAME, 'payload', json_build_object('id', OLD.id));
        ELSIF (TG_OP = 'TRUNCATE') THEN
          notification = json_build_object('type', 'TRUNCATE', 'table', TG_TABLE_NAME, 'payload', json_build_object());
        END IF;

        -- Publish the notification to the Elastic Search requests channel
        PERFORM pg_notify('${CHANNEL_NAME}', notification::text);

        RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    ${Object.values(ElasticSearchModelsAdapters)
      .map(
        adapter => `
    -- Create the trigger for INSERT operations
    CREATE OR REPLACE TRIGGER  ${adapter.model.tableName}_insert_trigger
    AFTER INSERT ON "${adapter.model.tableName}"
    FOR EACH ROW
    EXECUTE FUNCTION notify_elasticsearch_on_change();

    -- Create the trigger for UPDATE operations
    CREATE OR REPLACE TRIGGER  ${adapter.model.tableName}_update_trigger
    AFTER UPDATE ON "${adapter.model.tableName}"
    FOR EACH ROW
    EXECUTE FUNCTION notify_elasticsearch_on_change();

    -- Create the trigger for DELETE operations
    CREATE OR REPLACE TRIGGER  ${adapter.model.tableName}_delete_trigger
    AFTER DELETE ON "${adapter.model.tableName}"
    FOR EACH ROW
    EXECUTE FUNCTION notify_elasticsearch_on_change();

    -- Create the trigger for TRUNCATE operations
    CREATE OR REPLACE TRIGGER  ${adapter.model.tableName}_truncate_trigger
    AFTER TRUNCATE ON "${adapter.model.tableName}"
    FOR EACH STATEMENT
    EXECUTE FUNCTION notify_elasticsearch_on_change();
  `,
      )
      .join('\n')}
  `);
};

/**
 * @deprecated: To index entries directly. Use the batch processor instead.
 */
// const handleElasticSearchRequest = async (request: ElasticSearchRequest) => {
//   console.log('Received notification:', request);
//   const client = getElasticSearchClient({ throwIfUnavailable: true });
//   const adapter = getAdapterFromTableName(request.table);
//   if (!adapter) {
//     throw new Error(`No ElasticSearch adapter found for table ${request.table}`);
//   }

//   if (request.type === ElasticSearchRequestType.FULL_ACCOUNT_RE_INDEX) {
//     await elasticSearchFullAccountReIndex(request.payload.id);
//   } else if (request.type === ElasticSearchRequestType.UPDATE) {
//     const [entry] = await adapter.findEntriesToIndex({ ids: [request.payload.id] });
//     if (entry) {
//       await client.bulk({
//         index: adapter.index,
//         body: [{ index: { _id: request.payload.id } }, adapter.mapModelInstanceToDocument(entry)],
//       });
//     }
//   } else if (request.type === ElasticSearchRequestType.DELETE) {
//     await client.bulk({
//       index: adapter.index,
//       body: [{ delete: { _id: request.payload.id } }],
//     });
//   } else if (request.type === ElasticSearchRequestType.TRUNCATE) {
//     await client.deleteByQuery({
//       index: adapter.index,
//       body: { query: { match_all: {} } }, // eslint-disable-line camelcase
//     });
//   }
// };

export const startElasticSearchPostgresSync = async () => {
  const elasticSearchBatchProcessor = ElasticSearchBatchProcessor.getInstance();
  const subscriber = createSubscriber({ connectionString: getDBUrl('database') });

  subscriber.notifications.on(CHANNEL_NAME, async event => {
    console.log(event);
    try {
      // TODO: Check message format
      await elasticSearchBatchProcessor.addToQueue(event);
      // await handleElasticSearchRequest(event);
    } catch (error) {
      // TODO: maybe error handling in the batch processor?
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
