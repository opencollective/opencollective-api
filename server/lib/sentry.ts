/**
 * This file wraps Sentry for our API server. We are plugging it in 3 places:
 * 1. For the GraphQL API, in `server/routes.js` > GraphQL server plugin
 * 2. For all other REST endpoints, in `server/middleware/error_handler.js`
 * 3. As a fallback for the entire APP (esp. CRON jobs), in this own file (see `.on('unhandledRejection')`)
 */

import '../env';

import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';
import type { Integration, SeverityLevel } from '@sentry/types';
import axios, { AxiosError } from 'axios';
import config from 'config';
import { get, isEmpty, isEqual, pick } from 'lodash';

import FEATURE from '../constants/feature';
import { User } from '../models';

import logger from './logger';
import { safeJsonStringify, sanitizeObjectForJSON } from './safe-json-stringify';
import * as utils from './utils';

const getIntegrations = (expressApp = null): Integration[] => {
  const integrations: Integration[] = [new Sentry.Integrations.Http({ tracing: true })];
  if (expressApp) {
    integrations.push(new Tracing.Integrations.Express({ app: expressApp }));
  }
  return integrations;
};

const TRACES_SAMPLE_RATE = parseFloat(config.sentry.tracesSampleRate) || 0;

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
  if (request?.headers) {
    request.headers = utils.redactSensitiveFields(request.headers);
  }
};

export const initSentry = (expressApp = null) => {
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
    integrations: getIntegrations(expressApp),
    tracesSampler: samplingContext => {
      if (!samplingContext) {
        return 0;
      } else if (samplingContext.request?.url?.match(/\/graphql(\/.*)?$/)) {
        return 1; // GraphQL endpoints handle sampling manually in `server/routes.js`
      } else {
        return TRACES_SAMPLE_RATE;
      }
    },
  });
};

if (config.sentry?.dsn) {
  logger.info('Initializing Sentry');
  initSentry();

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
  REST = 'REST',
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
  { severity = 'error', tags, handler, extra, user, breadcrumbs, feature, requestPath }: CaptureErrorParams = {},
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

    Sentry.captureException(err);
  });
};

/**
 * Publish a message directly to Sentry
 */
export const reportMessageToSentry = (message: string, params: CaptureErrorParams = undefined) => {
  withScopeFromCaptureErrorParams(params, () => {
    Sentry.captureMessage(message, params?.severity || 'error');
  });
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
];

const isIgnoredGQLError = (err): boolean => {
  return IGNORED_GQL_ERRORS.some(ignoredError => {
    const isMatchingPath = !ignoredError.path || ignoredError.path.some(path => isEqual(err.path, path));
    return Boolean(isMatchingPath && err.message?.match(ignoredError.message));
  });
};

export const SentryGraphQLPlugin = {
  requestDidStart({ request, customTimeout = 30e3 }) {
    const transactionName = `GraphQL: ${request.operationName || 'Anonymous Operation'}`;
    let transaction = Sentry.getCurrentHub()?.getScope()?.getTransaction();
    if (transaction) {
      // Re-use any existing transaction (Sentry pricing is based on the transactions count)
      transaction.setName(transactionName);
    } else {
      transaction = Sentry.startTransaction({ op: 'graphql', name: transactionName });
    }

    // 30s timeout
    const finishTimeout = setTimeout(() => {
      transaction.setStatus('deadline_exceeded');
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore Property 'spanRecorder' does not exist on type 'Transaction'
      const spans: Sentry.Span[] = transaction.spanRecorder?.spans;
      if (!spans || !Array.isArray(spans)) {
        // Some defensive code since we're using an undocumented API, in case it changes in the future
        reportMessageToSentry('GraphQL transaction has no spans', {
          severity: 'warning',
          extra: { transactionName },
        });
      } else {
        spans.forEach(span => {
          if (!span.endTimestamp && span.op === 'resolver') {
            span.setStatus('deadline_exceeded');
            span.finish();
          }
        });
      }

      transaction.finish();
    }, customTimeout);

    return {
      executionDidStart() {
        return {
          willResolveField({ info }) {
            // hook for each new resolver
            const span = transaction.startChild({
              op: 'resolver',
              description: `${info.parentType.name}.${info.fieldName}`,
            });

            return (error = null) => {
              // this will execute once the resolver is finished
              if (error) {
                span.setData('error', error.message || error.toString());
                span.setStatus('internal_error');
              }
              span.finish();
            };
          },
        };
      },
      didEncounterErrors(ctx): void {
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
          let remoteUserForSentry: Sentry.User | undefined;
          if (ctx.context.remoteUser) {
            remoteUserForSentry = { id: ctx.context.remoteUser.id, CollectiveId: ctx.context.remoteUser.CollectiveId };
          }

          reportErrorToSentry(err, {
            handler: HandlerType.GQL,
            severity: 'error',
            user: remoteUserForSentry,
            tags: { kind: ctx.operation.operation },
            extra: { query: ctx.request.query, variables: JSON.stringify(ctx.request.variables) },
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
      willSendResponse(): void {
        clearTimeout(finishTimeout);
        if (transaction.op === 'graphql') {
          transaction.finish();
        }
      },
    };
  },
};

export { Sentry };
