import '../server/env.js';

import config from 'config';
import { get } from 'lodash-es';

import { getDBConf } from '../server/lib/db.js';

const dbConfig = getDBConf('database');

export default {
  ...dbConfig,
  dialectOptions: get(config.database.options, 'dialectOptions', {}),
};
