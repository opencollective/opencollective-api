import config from 'config';
import debugLib from 'debug';
import pg from 'pg';
import Sequelize from 'sequelize';

import { getDBConf } from '../lib/db';
import logger from '../lib/logger';

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
  if (process.env.NODE_ENV === 'production') {
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

export { Op } from 'sequelize';
export default sequelize;
