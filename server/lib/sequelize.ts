import config from 'config';
import debugLib from 'debug';
import pg from 'pg';
import { Model, Sequelize } from 'sequelize';

import { getDBConf } from './db';
import logger from './logger';
import { reportErrorToSentry } from './sentry';
import { parseToBoolean } from './utils';

// this is needed to prevent sequelize from converting integers to strings, when model definition isn't clear
// like in case of the key totalOrders and raw query (like User.getTopBackers())
pg.defaults.parseInt8 = true;

const dbConfig = getDBConf('database');
const debug = debugLib('psql');

/**
 * Database connection.
 */
logger.info(`Connecting to postgres://${dbConfig.host}/${dbConfig.database}`);

// If we launch the process with DEBUG=psql, we log the postgres queries
if (process.env.DEBUG && process.env.DEBUG.match(/psql/)) {
  config.database.options.logging = true;
}

if (process.env.PGSSLMODE === 'require') {
  config.database.options.dialectOptions = config.database.options.dialectOptions || {};
  config.database.options.dialectOptions = { ssl: { rejectUnauthorized: false } };
}

if (config.database.options.logging) {
  if (config.env === 'production') {
    config.database.options.logging = (query, executionTime) => {
      if (executionTime > 50) {
        debug(query.replace(/(\n|\t| +)/g, ' ').slice(0, 100), '|', executionTime, 'ms');
      }
    };
  } else {
    config.database.options.logging = (query, executionTime) => {
      debug(
        '\n-------------------- <query> --------------------\n',
        query,
        `\n-------------------- </query executionTime="${executionTime}"> --------------------\n`,
      );
    };
  }
}

if (config.database.options.pool) {
  if (config.database.options.pool.min) {
    config.database.options.pool.min = parseInt(config.database.options.pool.min, 10);
  }
  if (config.database.options.pool.max) {
    config.database.options.pool.max = parseInt(config.database.options.pool.max, 10);
  }
}

const sequelize = new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
  host: dbConfig.host,
  port: dbConfig.port,
  dialect: dbConfig.dialect,
  ...config.database.options,
});

// Add a debug mechanism to track the root caller in `pg_stat_activity` by prefixing all sequelize
// queries with a comment that identifies the originating function and path.
if (parseToBoolean(config.database.logQueryOrigin)) {
  /** Symbol used to thread the captured SQL comment through Sequelize's options
   *  object across async boundaries (runHooks writes it, Sequelize.query reads it). */
  const QUERY_ORIGIN = Symbol('queryOrigin');

  const excludeLineTexts = [
    'node_modules',
    'node:internal',
    'internal/process',
    'anonymous',
    'runMicrotasks',
    'Promise.',
  ];

  function captureOriginComment(belowFn: (...args: unknown[]) => unknown): string | null {
    const o: { stack?: string } = {};
    Error.captureStackTrace(o, belowFn);
    const lines = (o.stack ?? '').split(/\n/g).slice(1);
    const line = lines.find(l => !excludeLineTexts.some(t => l.includes(t)));
    if (!line) {
      return null;
    }
    const methodAndPath = line.replace(/(\s+at (async )?|[^a-z0-9.:/\\\-_ ]|:\d+\)?$)/gi, '');
    return methodAndPath ? `/* ${methodAndPath} */` : null;
  }

  // Model.runHooks is called synchronously at the start of every ORM method
  // (findAll, count, create, …) before any internal await.  The application
  // call frame is still on the stack here, so this is the right place to
  // capture the origin and attach it to the options object that will eventually
  // be passed to Sequelize.prototype.query.
  const modelWithHooks = Model as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
  const originalRunHooks = modelWithHooks.runHooks;
  modelWithHooks.runHooks = function (hookName: string, ...args: unknown[]) {
    if (hookName.startsWith('before')) {
      const lastArg = args[args.length - 1] as Record<symbol, unknown> | null;
      if (lastArg && typeof lastArg === 'object' && !lastArg[QUERY_ORIGIN]) {
        const comment = captureOriginComment(modelWithHooks.runHooks);
        if (comment) {
          lastArg[QUERY_ORIGIN] = comment;
        }
      }
    }
    return originalRunHooks.apply(this, [hookName, ...args]);
  };

  // Read the comment stored by the runHooks patch (ORM calls) or fall back to
  // a live stack capture for direct sequelize.query() calls from app code.
  const originalQuery = Sequelize.prototype.query;
  Sequelize.prototype.query = function (sql, options) {
    try {
      const sqlText = typeof sql === 'string' ? sql : (sql as { query?: string })?.query;
      if (typeof sqlText === 'string' && !sqlText.startsWith('/*')) {
        const comment =
          (options as Record<symbol, string> | undefined)?.[QUERY_ORIGIN] ??
          captureOriginComment(Sequelize.prototype.query as (...args: unknown[]) => unknown);
        if (comment) {
          if (typeof sql === 'string') {
            sql = `${comment} ${sql}`;
          } else {
            (sql as { query: string }).query = `${comment} ${sqlText}`;
          }
        }
      }
    } catch (e) {
      // Non-fatal — just skip the annotation
      reportErrorToSentry(e);
    }
    return originalQuery.call(this, sql, options);
  };
}

export {
  // @deprecated use the imports from 'sequelize' directly
  Op,
  // @deprecated use the imports from 'sequelize' directly
  DataTypes,
  // @deprecated use the imports from 'sequelize' directly
  Model,
  // @deprecated use the imports from 'sequelize' directly
  QueryTypes,
  // @deprecated use the imports from 'sequelize' directly
  Sequelize,
  // @deprecated use the imports from 'sequelize' directly
  Transaction,
} from 'sequelize';

export default sequelize;
