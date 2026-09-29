import querystring from 'querystring';

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import config from 'config';
import { cloneDeep, compact } from 'lodash';

import logger from '../logger';
import * as utils from '../utils';

import { METRIC_NAME_REGEX } from './metrics';

const TRACES_SAMPLE_RATE = parseFloat(config.sentry.tracesSampleRate) || 0;
const PROFILES_SAMPLE_RATE = parseFloat(config.sentry.profilesSampleRate) || 0;

export const checkIfSentryConfigured = () => Boolean(config.sentry?.dsn);

export enum HandlerType {
  GQL = 'GQL',
  EXPRESS = 'EXPRESS',
  CRON = 'CRON',
  FALLBACK = 'FALLBACK',
  WEBHOOK = 'WEBHOOK',
  OPENSEARCH_SYNC_JOB = 'OPENSEARCH_SYNC_JOB',
  EXPORTS_WORKER = 'EXPORTS_WORKER',
}

export const redactSensitiveDataFromRequest = rawRequest => {
  if (!rawRequest) {
    return;
  }

  // Redact from payload
  const request = cloneDeep(rawRequest);
  try {
    const reqBody = JSON.parse(request.data);
    request.data = JSON.stringify(utils.redactSensitiveFields(reqBody));
  } catch {
    // request data is not a json
  }

  // Redact from headers
  if (request.headers) {
    request.headers = utils.redactSensitiveFields(request.headers);
  }
  if (request.cookies) {
    request.cookies = utils.redactSensitiveFields(request.cookies);
  }

  // Redact fom query string
  if (request['query_string']) {
    if (typeof request['query_string'] === 'string') {
      request['query_string'] = querystring.parse(request['query_string']);
    }
    request['query_string'] = utils.redactSensitiveFields(request['query_string']);
  }

  return request;
};

/**
 * Safety net on top of the typed metrics wrapper (`./metrics`): drops any metric whose name
 * violates the metric name grammar (`<origin>.<provider>.<domain>.<event>`) so a bad name can
 * never mix series, and warns so the misuse is visible.
 */
export const beforeSendMetric = (metric: Sentry.Metric): Sentry.Metric | null => {
  if (!METRIC_NAME_REGEX.test(metric.name)) {
    logger.warn(`sentry: dropping metric with invalid name: ${metric.name}`);
    return null;
  }
  return metric;
};

Sentry.init({
  beforeSend(event) {
    event.request = redactSensitiveDataFromRequest(event.request);
    return event;
  },
  beforeSendTransaction(event) {
    event.request = redactSensitiveDataFromRequest(event.request);
    return event;
  },
  beforeSendMetric,
  dsn: config.sentry.dsn,
  environment: config.env,
  integrations: compact([
    PROFILES_SAMPLE_RATE > 0 && nodeProfilingIntegration(),
    Sentry.graphqlIntegration({ ignoreResolveSpans: false }),
  ]),
  attachStacktrace: true,
  enabled: config.env !== 'test',
  tracesSampler: samplingContext => {
    if (!TRACES_SAMPLE_RATE || !samplingContext) {
      return 0;
    } else if (samplingContext.normalizedRequest?.headers?.['x-sentry-force-sample']) {
      return 1;
    } else {
      return samplingContext.inheritOrSampleWith(TRACES_SAMPLE_RATE);
    }
  },
  // Relative to tracesSampler
  profilesSampleRate: PROFILES_SAMPLE_RATE,
  release: process.env.HEROKU_SLUG_COMMIT,
  dist: config.env,
});

export default Sentry;
