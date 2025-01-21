/**
 * This file wraps Sentry for our API server. We are plugging it in 3 places:
 * 1. For the GraphQL API, in `server/routes.js` > GraphQL server plugin
 * 2. For all other REST endpoints, in `server/middleware/error-handler.js`
 * 3. As a fallback for the entire APP (esp. CRON jobs), in this own file (see `.on('unhandledRejection')`)
 */

import '../../env';

import { ApolloServerPlugin } from '@apollo/server';
import * as Sentry from '@sentry/node';
import { SeverityLevel } from '@sentry/node';
import axios, { AxiosError } from 'axios';
import config from 'config';
import { get, isEmpty, isEqual, pick } from 'lodash';

import FEATURE from '../../constants/feature';
import { User } from '../../models';
import logger from '../logger';
import { safeJsonStringify, sanitizeObjectForJSON } from '../safe-json-stringify';

import { checkIfSentryConfigured, HandlerType, redactSensitiveDataFromRequest } from './init';

export type CaptureErrorParams = {
  severity?: SeverityLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  breadcrumbs?: Sentry.Breadcrumb[];
  user?: Sentry.User | User;
  handler?: HandlerType | `${HandlerType}`;
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

if (checkIfSentryConfigured()) {
  logger.info(`Initializing Sentry in ${config.env} environment `);

  // Catch all errors that haven't been caught anywhere else
  process
    .on('unhandledRejection', (reason: any) => {
      reportErrorToSentry(reason, { severity: 'fatal', handler: HandlerType.FALLBACK });
    })
    .on('uncaughtException', (err: Error) => {
      reportErrorToSentry(err, { severity: 'fatal', handler: HandlerType.FALLBACK });
    });
}

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

const simplifyReq = req =>
  !req
    ? undefined
    : pick(req, [
        'method',
        'url',
        'isGraphQL',
        'query',
        'params',
        'session',
        'jwtPayload',
        'path',
        'cacheKey',
        'cacheSlug',
        'startAt',
        'endAt',
        'remoteUser.id',
        'userToken.id',
        'personalToken.id',
        'clientApp.id',
        'rawBody',
      ]);

/**
 * Helper to capture an error on Sentry
 */
export const reportErrorToSentry = (err: Error, params: CaptureErrorParams = {}): void => {
  if (checkIfSentryConfigured()) {
    withScopeFromCaptureErrorParams(params, (scope: Sentry.Scope) => {
      // Add some more data if the error is an Axios error
      if (axios.isAxiosError(err)) {
        enhanceScopeWithAxiosError(scope, err, params);
      }

      Sentry.captureException(err);
    });
  } else {
    logger.error(
      err.stack ? err.stack : err.message,
      sanitizeObjectForJSON({
        ...params,
        req: redactSensitiveDataFromRequest(simplifyReq(params.req)),
      }),
    );
  }
};

/**
 * Publish a message directly to Sentry
 */
export const reportMessageToSentry = (message: string, params: CaptureErrorParams = undefined) => {
  withScopeFromCaptureErrorParams(params, () => {
    if (checkIfSentryConfigured()) {
      Sentry.captureMessage(message, params?.severity || 'error');
    } else {
      const errorDetailsStr = safeJsonStringify(params);
      const logMsg = `[Sentry fallback] ${message} (${errorDetailsStr})`;
      if (params?.severity === 'warning') {
        logger.warn(logMsg);
      } else {
        logger.error(logMsg);
      }
    }
  });
};

// // GraphQL
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
    Sentry.getCurrentScope()?.setTransactionName(transactionName);
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

export { Sentry, HandlerType };
