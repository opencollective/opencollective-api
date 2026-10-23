/** db.js -- Postgres utilities that are out of the scope of our ORM:
 * connection config, LISTEN/NOTIFY subscribers and triggers.
 */
import config from 'config';
import { get, has } from 'lodash';
import pg from 'pg';
import pgConnectionString from 'pg-connection-string';
import createSubscriber from 'pg-listen';

import { reportErrorToSentry } from './sentry';
import { ifStr, parseToBoolean } from './utils';

if (parseToBoolean(config.database.logQueryOrigin)) {
  const excludeLineTexts = [
    'node_modules',
    'node:internal',
    'internal/process',
    'anonymous',
    'runMicrotasks',
    'Promise.',
  ];
  const originalQuery = pg.Client.prototype.query;

  pg.Client.prototype.query = function (...args) {
    try {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;

      // Skip queries that already carry a comment (added by the Sequelize or
      // Kysely patches further up the call chain).
      if (typeof sql === 'string' && sql.startsWith('/*')) {
        return originalQuery.apply(this, args);
      }

      const o = {};
      Error.captureStackTrace(o, pg.Client.prototype.query);
      const lines = o.stack.split(/\n/g).slice(1);
      const line = lines.find(l => !excludeLineTexts.some(t => l.includes(t)));

      if (line) {
        const methodAndPath = line.replace(/(\s+at (async )?|[^a-z0-9.:/\\\-_ ]|:\d+\)?$)/gi, '');
        if (methodAndPath) {
          const comment = `/* ${methodAndPath} */`;
          if (typeof args[0] === 'string') {
            args[0] = `${comment} ${args[0]}`;
          } else if (args[0] && typeof args[0] === 'object' && typeof args[0].text === 'string') {
            args[0] = { ...args[0], text: `${comment} ${args[0].text}` };
          }
        }
      }
    } catch (e) {
      reportErrorToSentry(e);
    }

    return originalQuery.apply(this, args);
  };
}

/** Retrieve configuration parameters of a given database.
 *
 * @param {string} name of the key in the configuration that contains
 *  the database parameters. An error is thrown if there's no section
 *  with such name.
 * @return an object with the keys `database`, `username`, `password`,
 *  `host`, and `port`. The key `port` is the only optional one and
 *  defaults to 5432.
 */
export function getDBConf(name) {
  if (!has(config, [name, 'url'])) {
    throw new Error(`Configuration missing key "${name}.url"`);
  }
  let dbConfig = parseDBUrl(get(config, [name, 'url']));
  if (name === 'database') {
    const dbConfigOverride = get(config, [name, 'override'], {});
    dbConfig = { ...dbConfig, ...dbConfigOverride };
  }
  return dbConfig;
}

/** Get a config object from an URL
 *
 * @param {string} url of a database
 */
function parseDBUrl(url) {
  const { database, user, password, host, port, dialect } = pgConnectionString.parse(url);
  return { database, username: user, password, host, port: port || 5432, dialect: dialect || 'postgres' };
}

/** Assemble an URL from database connection options.
 *
 * @param {string} section of the configuration file that will be read
 *  to assemble the URL. The configuration section MUST have the
 *  following fields: `database`, `username`, `password`
 *  `options.host` and optionally `options.port`.
 */
function getDBUrl(section) {
  const { database, username, password, host, port } = getDBConf(section);
  return `postgresql://${username}:${password}@${host}:${port}/${database}`;
}

export const createPostgresListener = () => {
  return createSubscriber({
    connectionString: getDBUrl('database'),
    ...config.database.options.dialectOptions,
  });
};

/**
 * Setup Postgres triggers for a given table and channel
 * @param {object} sequelize - Sequelize instance
 * @param {string} channelName - Name of the notification channel
 * @param {string} functionName - Name of the trigger function
 * @param {Array<{tableName: string, triggerPrefix: string}>} tables - Array of table configurations
 * @param {object} options - Options for trigger setup
 * @param {boolean} options.insertTriggersUpdate - If true, INSERT triggers will send 'UPDATE' notifications
 * @param {Array<string>} options.operations - Array of operations to create triggers for (INSERT, UPDATE, DELETE)
 * @return {Promise<void>}
 */
export async function setupPostgresTriggers(
  sequelize,
  channelName,
  functionName,
  tables,
  { insertTriggersUpdate, operations = ['INSERT', 'UPDATE', 'DELETE'] } = {
    insertTriggersUpdate: true,
    operations: ['INSERT', 'UPDATE', 'DELETE'],
  },
) {
  const normalizedOperations = operations.map(op => op.toUpperCase());
  const triggerFunction = `
    -- Create a trigger function to send notifications on table changes
    CREATE OR REPLACE FUNCTION ${functionName}()
    RETURNS TRIGGER AS $$
    DECLARE
        notification JSON;
    BEGIN
        -- Determine the type of operation
        IF (TG_OP = 'INSERT') THEN
          notification = json_build_object('type', '${insertTriggersUpdate ? 'UPDATE' : 'INSERT'}',  'table', TG_TABLE_NAME, 'payload', json_build_object('id', NEW.id));
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

        -- Publish the notification to the channel
        PERFORM pg_notify('${channelName}', notification::text);

        RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `;

  const triggers = tables
    .map(
      ({ tableName, triggerPrefix }) => `
    -- Create the trigger for INSERT operations
    ${ifStr(normalizedOperations.includes('INSERT'), `CREATE OR REPLACE TRIGGER ${triggerPrefix}_insert_trigger AFTER INSERT ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION ${functionName}();`)}
    -- Create the trigger for UPDATE operations
    ${ifStr(normalizedOperations.includes('UPDATE'), `CREATE OR REPLACE TRIGGER ${triggerPrefix}_update_trigger AFTER UPDATE ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION ${functionName}();`)}
    -- Create the trigger for DELETE operations
    ${ifStr(normalizedOperations.includes('DELETE'), `CREATE OR REPLACE TRIGGER ${triggerPrefix}_delete_trigger AFTER DELETE ON "${tableName}" FOR EACH ROW EXECUTE FUNCTION ${functionName}();`)}
    `,
    )
    .join('\n');

  await sequelize.query(triggerFunction + triggers);
}

/**
 * Remove Postgres triggers for a given table and function
 * @param {object} sequelize - Sequelize instance
 * @param {string} functionName - Name of the trigger function
 * @param {Array<{tableName: string, triggerPrefix: string}>} tables - Array of table configurations
 */
export async function removePostgresTriggers(sequelize, functionName, tables) {
  const dropTriggers = tables
    .map(
      ({ tableName, triggerPrefix }) => `
    DROP TRIGGER IF EXISTS ${triggerPrefix}_insert_trigger ON "${tableName}";
    DROP TRIGGER IF EXISTS ${triggerPrefix}_update_trigger ON "${tableName}";
    DROP TRIGGER IF EXISTS ${triggerPrefix}_delete_trigger ON "${tableName}";
  `,
    )
    .join('\n');

  await sequelize.query(
    `${dropTriggers}
    DROP FUNCTION IF EXISTS ${functionName}();
  `,
  );
}
