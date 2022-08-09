/**
 * This file wraps Sentry for our API server. We are plugging it in 3 places:
 * 1. For the GraphQL API, in `server/routes.js` > GraphQL server plugin
 * 2. For all other REST endpoints, in `server/middleware/error_handler.js`
 * 3. As a fallback for the entire APP (esp. CRON jobs), in this own file (see `.on('unhandledRejection')`)
 */

import '../env';

import * as Sentry from '@sentry/node';
import type { SeverityLevel } from '@sentry/types';
import axios, { AxiosError } from 'axios';
import config from 'config';
import { isEmpty, isEqual, pick } from 'lodash';

import FEATURE from '../constants/feature';

import logger from './logger';
import { safeJsonStringify, sanitizeObjectForJSON } from './safe-json-stringify';

if (config.sentry?.dsn) {
  logger.info('Initializing Sentry');
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.env,
    attachStacktrace: true,
    enabled: config.env !== 'test',
  });

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
  user?: Sentry.User;
  handler?: HandlerType;
  feature?: FEATURE;
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

const enhanceScopeWithAxiosError = (scope: Sentry.Scope, err: AxiosError) => {
  scope.setTag('lib_axios', 'true');
  if (err.request) {
    scope.setExtra('axios_request', JSON.stringify(pick(err.request, ['method', 'url', 'path']), null, 2));
    scope.setTransactionName(`Axios query: ${err.request.method} ${err.request.path}`);
    const fingerPrint = ['axios', err.request.method, err.request.path];
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
  { severity = 'error', tags, handler, extra, user, breadcrumbs, feature }: CaptureErrorParams = {},
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
    if (!isEmpty(tags)) {
      Object.entries(tags).forEach(([tag, value]) => scope.setTag(tag, value));
    }

    // Set user
    if (user) {
      scope.setUser(user);
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
      enhanceScopeWithAxiosError(scope, err);
    }

    Sentry.captureException(err);
  });
};

setTimeout(async () => {
  try {
    await axios.post('http://localhost:3060/graphql');
  } catch (e) {
    reportErrorToSentry(e);
  }
}, 3000);

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
  requestDidStart(): Record<string, unknown> {
    return {
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
    };
  },
};

export { Sentry };
