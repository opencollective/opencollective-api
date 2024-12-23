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
  ELASTICSEARCH_SYNC_JOB = 'ELASTICSEARCH_SYNC_JOB',
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
    } else if (samplingContext.request?.url?.match(/\/graphql(\/.*)?$/)) {
      return 1; // GraphQL endpoints handle sampling manually in `server/routes.js`
    } else {
      return TRACES_SAMPLE_RATE;
    }
  },
  // Relative to tracesSampler
  profilesSampleRate: PROFILES_SAMPLE_RATE,
});

export default Sentry;
