import config from 'config';
import debugLib from 'debug';
import pg from 'pg';
import { DataTypes, Sequelize, Utils } from 'sequelize';

import { getDBConf } from './db';
import logger from './logger';

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

addPointDataType();

const sequelize = new Sequelize(dbConfig.database, dbConfig.username, dbConfig.password, {
  host: dbConfig.host,
  port: dbConfig.port,
  dialect: dbConfig.dialect,
  ...config.database.options,
});

export { Op, Model, QueryTypes, Sequelize, Transaction } from 'sequelize';
export { DataTypes };
export default sequelize;

function addPointDataType() {
  class Point extends DataTypes.ABSTRACT {
    toSql() {
      return 'POINT';
    }
  }

  // Mandatory: set the type key
  Point.prototype.key = Point.key = 'POINT';

  // Mandatory: add the new type to DataTypes. Optionally wrap it on `Utils.classToInvokable` to
  // be able to use this datatype directly without having to call `new` on it.
  DataTypes.POINT = Utils.classToInvokable(Point);

  // Optional: disable escaping after stringifier. Do this at your own risk, since this opens opportunity for SQL injections.
  // DataTypes.POINT.escape = false;

  // const PgTypes = DataTypes.postgres;

  // // Mandatory: map postgres datatype name
  // DataTypes.POINT.types.postgres = ['point'];

  // // Mandatory: create a postgres-specific child datatype with its own parse
  // // method. The parser will be dynamically mapped to the OID of pg_new_type.
  // PgTypes.POINT = function POINT() {
  //   if (!(this instanceof PgTypes.POINT)) {
  //     return new PgTypes.POINT();
  //   }
  //   DataTypes.POINT.apply(this, arguments);
  // };
  // util.inherits(PgTypes.POINT, DataTypes.POINT);

  // // Mandatory: create, override or reassign a postgres-specific parser
  // // PgTypes.POINT.parse = value => value;
  // PgTypes.POINT.parse = DataTypes.POINT.parse || (x => x);

  // Optional: add or override methods of the postgres-specific datatype
  // like toSql, escape, validate, _stringify, _sanitize...
}
