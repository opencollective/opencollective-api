/**
 * This file wraps Sentry for our API server. We are plugging it in 3 places:
 * 1. For the GraphQL API, in `server/routes.js` > GraphQL server plugin
 * 2. For all other REST endpoints, in `server/middleware/error_handler.js`
 * 3. As a fallback for the entire APP (esp. CRON jobs), in this own file (see `.on('unhandledRejection')`)
 */

import '../env';

import { ApolloServerPlugin } from '@apollo/server';
import * as Sentry from '@sentry/node';
import type { SeverityLevel } from '@sentry/types';
import axios, { AxiosError } from 'axios';
import config from 'config';
import { get, isEmpty, isEqual, pick } from 'lodash';

import FEATURE from '../constants/feature';
import { User } from '../models';

import logger from './logger';
import { safeJsonStringify, sanitizeObjectForJSON } from './safe-json-stringify';
import * as utils from './utils';

const TRACES_SAMPLE_RATE = parseFloat(config.sentry.tracesSampleRate) || 0;
const MIN_EXECUTION_TIME_TO_SAMPLE = parseInt(config.sentry.minExecutionTimeToSample);

const checkIfSentryConfigured = () => Boolean(config.sentry?.dsn);

const redactSensitiveDataFromRequest = request => {
  if (!request) {
    return;
  }

  // Redact from payload
  try {
    const reqBody = JSON.parse(request.data);
    request.data = JSON.stringify(utils.redactSensitiveFields(reqBody));
  } catch (e) {
    // request data is not a json
  }

  // Redact from headers
  if (request.headers) {
    request.headers = utils.redactSensitiveFields(request.headers);
  }

  // Redact fom query string
  if (request['query_string']) {
    request['query_string'] = utils.redactSensitiveFields(request['query_string']);
  }
};

Sentry.init({
  beforeSend(event) {
    redactSensitiveDataFromRequest(event.request);
    return event;
  },
  beforeSendTransaction(event) {
    redactSensitiveDataFromRequest(event.request);
    return event;
  },
  dsn: config.sentry.dsn,
  environment: config.env,
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
});

if (checkIfSentryConfigured()) {
  logger.info('Initializing Sentry');

  // Catch all errors that haven't been caught anywhere else
  process
    .on('unhandledRejection', (reason: any) => {
      reportErrorToSentry(reason, { severity: 'fatal', handler: HandlerType.FALLBACK });
    })
    .on('uncaughtException', (err: Error) => {
      reportErrorToSentry(err, { severity: 'fatal', handler: HandlerType.FALLBACK });
    });
}

export enum HandlerType {
  GQL = 'GQL',
  EXPRESS = 'EXPRESS',
  CRON = 'CRON',
  FALLBACK = 'FALLBACK',
}

type CaptureErrorParams = {
  severity?: SeverityLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  breadcrumbs?: Sentry.Breadcrumb[];
  user?: Sentry.User | User;
  handler?: HandlerType;
  feature?: FEATURE;
  transactionName?: string;
  /** Used to group Axios errors, when the URL includes parameters */
  requestPath?: string;
  req?: Express.Request;
};

export const dbUserToSentryUser = (user: User): Sentry.User => {
  if (!user) {
    return null;
  } else {
    return {
      id: user['id'].toString(),
      email: user['email'],
      username: get(user, 'collective.slug'),
      ip_address: get(user, 'data.lastSignInRequest.ip')?.toString(), // eslint-disable-line camelcase
    };
  }
};

const stringifyExtra = (value: unknown) => {
  if (typeof value === 'string') {
    return value;
  } else if (value === null) {
    return 'null';
  } else if (value === undefined) {
    return 'undefined';
  } else if (value instanceof Error) {
    return JSON.stringify(sanitizeObjectForJSON(value), Object.getOwnPropertyNames(value));
  } else if (typeof value === 'object') {
    return safeJsonStringify(value);
  } else {
    return value?.toString();
  }
};

const enhanceScopeWithAxiosError = (scope: Sentry.Scope, err: AxiosError, params: CaptureErrorParams) => {
  scope.setTag('lib_axios', 'true');
  if (err.request) {
    scope.setExtra('axios_request', JSON.stringify(pick(err.request, ['method', 'url', 'path']), null, 2));
    scope.setTransactionName(`Axios query: ${err.request.method} ${err.request.path}`);
    const fingerPrint = ['axios', err.request.method, params.requestPath || err.request.path];
    if (err.response) {
      fingerPrint.push(String(err.response.status));
    }

    scope.setFingerprint(fingerPrint);
  }
  if (err.response) {
    scope.setExtra('axios_response_status', err.response.status);
    scope.setExtra('axios_response_body', JSON.stringify(err.response.data, null, 2) || 'undefined');
    scope.setExtra('axios_response_headers', JSON.stringify(err.response.headers, null, 2) || 'undefined');
  }
};

const withScopeFromCaptureErrorParams = (
  { severity = 'error', tags, handler, extra, user, breadcrumbs, feature, requestPath, req }: CaptureErrorParams = {},
  callback: (scope: Sentry.Scope) => void,
) => {
  Sentry.withScope(scope => {
    scope.setLevel(severity);

    // Set tags
    if (handler) {
      scope.setTag('handler', handler);
    }
    if (feature) {
      scope.setTag('feature', feature);
    }
    if (requestPath) {
      scope.setTag('requestPath', requestPath);
    }
    if (!isEmpty(tags)) {
      Object.entries(tags).forEach(([tag, value]) => scope.setTag(tag, value));
    }

    // Set user
    if (user) {
      const sentryUser = user instanceof User ? dbUserToSentryUser(user) : user;
      scope.setUser(sentryUser);
    }

    // Set breadcrumbs
    if (breadcrumbs) {
      breadcrumbs.forEach(breadcrumb => scope.addBreadcrumb(breadcrumb));
    }

    // Set extra
    if (!isEmpty(extra)) {
      Object.entries(extra).forEach(([key, value]) => scope.setExtra(key, stringifyExtra(value)));
    }

    // Add Request data to scope
    if (req) {
      scope.setSDKProcessingMetadata({ request: req });
      if (req.remoteUser) {
        scope.setUser(dbUserToSentryUser(req.remoteUser));
      }
    }

    callback(scope);
  });
};

/**
 * Helper to capture an error on Sentry
 */
export const reportErrorToSentry = (err: Error, params: CaptureErrorParams = {}): void => {
  withScopeFromCaptureErrorParams(params, (scope: Sentry.Scope) => {
    // Add some more data if the error is an Axios error
    if (axios.isAxiosError(err)) {
      enhanceScopeWithAxiosError(scope, err, params);
    }

    if (checkIfSentryConfigured()) {
      Sentry.captureException(err);
    } else {
      logger.error(
        `[Sentry disabled] The following error would be reported: ${err.message} (${JSON.stringify({
          err,
          params,
          stacktrace: err.stack,
        })})`,
      );
    }
  });
};

/**
 * Publish a message directly to Sentry
 */
export const reportMessageToSentry = (message: string, params: CaptureErrorParams = undefined) => {
  withScopeFromCaptureErrorParams(params, () => {
    if (checkIfSentryConfigured()) {
      Sentry.captureMessage(message, params?.severity || 'error');
    } else {
      logger.error(`[Sentry disabled] The following message would be reported: ${message} (${JSON.stringify(params)})`);
    }
  });
};

export const sentryHandleSlowRequests = (executionTime: number) => {
  const sentryTransaction = Sentry.getCurrentHub().getScope()?.getTransaction();
  if (sentryTransaction) {
    if (sentryTransaction.status === 'deadline_exceeded' || executionTime >= MIN_EXECUTION_TIME_TO_SAMPLE) {
      sentryTransaction.setTag('graphql.slow', 'true');
      sentryTransaction.setTag('graphql.executionTime', executionTime);
      sentryTransaction.sampled = true; // Make sure we always report timeouts and slow requests
    } else if (Math.random() > TRACES_SAMPLE_RATE) {
      sentryTransaction.sampled = false; // We explicitly set `sampled` to false if we don't want to sample, to handle cases we're it's forced to `1`
    }
  }
};

// GraphQL

const IGNORED_GQL_ERRORS = [
  {
    message: /^No collective found/,
    path: [
      // GQL V1
      ['Collective'],
      ['allMembers'],
      // GQL V2
      ['account'],
      ['collective'],
      ['event'],
      ['fund'],
      ['host'],
      ['individual'],
      ['organization'],
      ['project'],
    ],
  },
  {
    message: /^Invalid collectiveSlug \(not found\)$/,
    path: [['allMembers']],
  },
  {
    message: /^Your card was declined.$/,
    path: [['createOrder']],
  },
  {
    message: /The slug .+ is already taken/,
    path: [['createOrganization'], ['createCollective'], ['createFund'], ['createProject']],
  },
];

const isIgnoredGQLError = (err): boolean => {
  return IGNORED_GQL_ERRORS.some(ignoredError => {
    const isMatchingPath = !ignoredError.path || ignoredError.path.some(path => isEqual(err.path, path));
    return Boolean(isMatchingPath && err.message?.match(ignoredError.message));
  });
};

export const SentryGraphQLPlugin: ApolloServerPlugin = {
  async requestDidStart({ request }) {
    // There's normally no parent transaction, but just in case there's one  - either because it was created in the parent context or
    // if we go back to the default Sentry middleware, we want to make sure we don't create a new transaction
    const transactionName = `GraphQL: ${request.operationName || 'Anonymous Operation'}`;
    let transaction = Sentry.getCurrentHub()?.getScope()?.getTransaction();
    if (transaction) {
      transaction.setName(transactionName);
    } else {
      transaction = Sentry.startTransaction({ op: 'graphql', name: transactionName });
    }

    return {
      async didEncounterErrors(ctx): Promise<void> {
        // If we couldn't parse the operation, don't do anything here
        if (!ctx.operation) {
          return;
        }

        for (const err of ctx.errors) {
          // Only report internal server errors, all errors extending ApolloError should be user-facing
          if (err.extensions?.code || isIgnoredGQLError(err)) {
            continue;
          }

          // Try to generate a User object for Sentry if logged in
          const req = ctx.contextValue as Express.Request;
          reportErrorToSentry(err, {
            handler: HandlerType.GQL,
            severity: 'error',
            tags: { kind: ctx.operation.operation },
            req,
            extra: {
              query: ctx.request.query,
              variables: utils.redactSensitiveFields(ctx.request.variables || {}),
            },
            breadcrumbs: err.path && [
              {
                category: 'query-path',
                message: err.path.join(' > '),
                level: 'debug' as SeverityLevel,
              },
            ],
          });
        }
      },
    };
  },
};

export { Sentry };
