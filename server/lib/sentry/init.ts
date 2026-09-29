import querystring from 'querystring';

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import config from 'config';
import { cloneDeep, compact } from 'lodash';

import * as utils from '../utils';

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

Sentry.init({
  beforeSend(event) {
    event.request = redactSensitiveDataFromRequest(event.request);
    return event;
  },
  beforeSendTransaction(event) {
    event.request = redactSensitiveDataFromRequest(event.request);
    return event;
  },
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
  // Sentry 11 defaults to span streaming, which turns `beforeSendTransaction` (used above to redact request data)
  // into a no-op. Keep the transaction-based model until that redaction is moved to `beforeSendSpan`.
  traceLifecycle: 'static',
  // Sentry 11 collects request/response bodies, cookies, unscrubbed headers, DB query data, etc. by default.
  // This explicitly keeps the Sentry 10 baseline, see:
  // https://github.com/getsentry/sentry-javascript/blob/11.0.0/MIGRATION.md#senddefaultpii-is-replaced-by-datacollection
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
      response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
    },
    httpBodies: [],
    urlQueryParams: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
  },
  // Sentry 11 replaced the per-transaction `profilesSampleRate` with session-based profiling: the rate is evaluated
  // once per process, and `profileLifecycle: 'trace'` then profiles every sampled trace of the sampled processes.
  profileSessionSampleRate: PROFILES_SAMPLE_RATE,
  profileLifecycle: 'trace',
  release: process.env.HEROKU_SLUG_COMMIT,
  dist: config.env,
});

export default Sentry;
