import fs from 'fs';
import path from 'path';

import debug from 'debug';
import dotenv from 'dotenv';
import { get, has, last } from 'lodash';

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
if (!process.env.PG_URL) {
  const pgUrlEnvironmentVariable = get(process.env, 'PG_URL_ENVIRONMENT_VARIABLE', 'DATABASE_URL');
  if (has(process.env, pgUrlEnvironmentVariable)) {
    process.env.PG_URL = get(process.env, pgUrlEnvironmentVariable);
  }
}

// Compute REDIS_URLs
if (!process.env.REDIS_URL) {
  const redisUrlEnvironmentVariable = process.env.REDIS_URL_ENVIRONMENT_VARIABLE;
  if (redisUrlEnvironmentVariable && has(process.env, redisUrlEnvironmentVariable)) {
    process.env.REDIS_URL = get(process.env, redisUrlEnvironmentVariable);
  }
}
if (!process.env.REDIS_TIMELINE_URL) {
  const redisTimelineUrlEnvironmentVariable = process.env.REDIS_TIMELINE_URL_ENVIRONMENT_VARIABLE;
  if (redisTimelineUrlEnvironmentVariable && has(process.env, redisTimelineUrlEnvironmentVariable)) {
    process.env.REDIS_TIMELINE_URL = get(process.env, redisTimelineUrlEnvironmentVariable);
  }
}
