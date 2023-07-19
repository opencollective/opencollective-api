import url from 'url';
const __dirname = url.fileURLToPath(new url.URL('.', import.meta.url));
import fs from 'fs';
import path from 'path';

import debug from 'debug';
import dotenv from 'dotenv';
import { get, has, last } from 'lodash-es';

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'development';
}

if (!process.env.OC_ENV) {
  process.env.OC_ENV = process.env.NODE_ENV;
}

// This will be used by the "config" package
if (!process.env.NODE_CONFIG_ENV) {
  process.env.NODE_CONFIG_ENV = process.env.OC_ENV;
}

// Load extra env file on demand
// `npm run dev staging` / `npm run dev production`
if (process.env.EXTRA_ENV || process.env.OC_ENV === 'development') {
  const extraEnv = process.env.EXTRA_ENV || last(process.argv);
  const extraEnvPath = path.join(__dirname, '..', `.env.${extraEnv}`);
  if (fs.existsSync(extraEnvPath)) {
    dotenv.config({ path: extraEnvPath });
  }
}

dotenv.config();

debug.enable(process.env.DEBUG);

// Normalize Memcachier environment variables (production / heroku)
if (process.env.MEMCACHIER_SERVERS) {
  process.env.MEMCACHE_SERVERS = process.env.MEMCACHIER_SERVERS;
}
if (process.env.MEMCACHIER_USERNAME) {
  process.env.MEMCACHE_USERNAME = process.env.MEMCACHIER_USERNAME;
}
if (process.env.MEMCACHIER_PASSWORD) {
  process.env.MEMCACHE_PASSWORD = process.env.MEMCACHIER_PASSWORD;
}

// Normalize Statsd environment variables (production / heroku)
if (process.env.HOSTEDGRAPHITE_APIKEY) {
  process.env.STATSD_PREFIX = `${process.env.HOSTEDGRAPHITE_APIKEY}.`;
}

// Compute PG_URL based on PG_URL_ENVIRONMENT_VARIABLE, look in DATABASE_URL by default
const pgUrlEnvironmentVariable = get(process.env, 'PG_URL_ENVIRONMENT_VARIABLE', 'DATABASE_URL');
if (has(process.env, pgUrlEnvironmentVariable) && !has(process.env, 'PG_URL')) {
  process.env.PG_URL = get(process.env, pgUrlEnvironmentVariable);
}
