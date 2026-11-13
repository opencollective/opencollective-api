import config from 'config';
import type { GraphQLFormattedError } from 'graphql';
import { get, pick } from 'lodash';

import { DATABASE_ERROR_PUBLIC_MESSAGE, isDatabaseError } from '../lib/database-errors';
import logger from '../lib/logger';
import { parseToBoolean } from '../lib/utils';

import { IGNORED_GRAPHQL_ERROR_CODES } from './errors';

/**
 * Apollo `formatError` hook, shared by GraphQL V1 and V2.
 * See https://www.apollographql.com/docs/apollo-server/api/apollo-server#formaterror
 */
export const formatGraphQLError = (formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError => {
  if (IGNORED_GRAPHQL_ERROR_CODES.includes(formattedError.extensions?.code as string)) {
    return formattedError;
  }

  logger.error(`GraphQL error: ${formattedError.message}`);
  const extra = pick(formattedError, ['locations', 'path']);
  if (Object.keys(extra).length) {
    logger.error(JSON.stringify(extra));
  }

  const stacktrace = get(formattedError, 'extensions.exception.stacktrace');
  if (stacktrace) {
    logger.error(stacktrace);
  }

  if (parseToBoolean(config.graphql.error.detailed)) {
    /* eslint-disable no-console */
    console.log(formattedError);
    console.log(error);
    /* eslint-enable no-console */
  }

  // Never leak database errors (Postgres messages, SQL, schema details) to clients. They're logged above
  // and reported to Sentry by `SentryGraphQLPlugin`.
  if (isDatabaseError(error)) {
    return {
      message: DATABASE_ERROR_PUBLIC_MESSAGE,
      ...pick(formattedError, ['locations', 'path']),
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    };
  }

  return formattedError;
};
