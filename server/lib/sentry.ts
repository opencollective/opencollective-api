/**
 * This file wraps Sentry for our API server. We are plugging it in 3 places:
 * 1. For the GraphQL API, in `server/routes.js` > GraphQL server plugin
 * 2. For all other REST endpoints, in `server/middleware/error_handler.js`
 * 3. As a fallback for the entire APP (esp. CRON jobs), in this own file (see `.on('unhandledRejection')`)
 */

import '../env';

import * as Sentry from '@sentry/node';
import type { SeverityLevel } from '@sentry/types';
import config from 'config';
import { isEmpty, isEqual } from 'lodash';

import logger from './logger';

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
};

/**
 * Helper to capture an error on Sentry
 */
export const reportErrorToSentry = (
  err: Error,
  { severity = 'error', tags, handler, extra, user, breadcrumbs }: CaptureErrorParams = {},
): void => {
  Sentry.withScope(scope => {
    scope.setLevel(severity);

    // Set tags
    if (handler) {
      scope.setTag('handler', handler);
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
      Object.entries(extra).forEach(([key, value]) => scope.setExtra(key, value));
    }

    Sentry.captureException(err);
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
