require('../server/env');

const config = require('config');
const { get } = require('lodash');

const { getDBConf } = require('../server/lib/db');

const dbConfig = getDBConf('database');

module.exports = {
  ...dbConfig,
  dialectOptions: get(config.database.options, 'dialectOptions', {}),
};
