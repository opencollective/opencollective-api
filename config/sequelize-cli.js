import '../server/env';

import config from 'config';
import { get } from 'lodash';

import { getDBConf } from '../server/lib/db';

const dbConfig = getDBConf('database');

// ignore unused exports default
export default {
  ...dbConfig,
  dialectOptions: get(config.database.options, 'dialectOptions', {}),
};
