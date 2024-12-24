import { ApolloServerPluginUsageReporting } from '@apollo/server/plugin/usageReporting';
import { AxiosError } from 'axios';
import config from 'config';
import { GraphQLError } from 'graphql';
import { isNil, orderBy, pick, round, uniqBy } from 'lodash';

import { ContentNotReady } from '../graphql/errors';

import cache from './cache';
import logger from './logger';

const minExecutionTimeToCache = parseInt(config.graphql.cache.minExecutionTimeToCache);

const enablePluginIf = (condition, plugin) => (condition ? plugin : {});

export const apolloSlowRequestCachePlugin = {
  async requestDidStart() {
    return {
      async willSendResponse(requestContext) {
        const response = requestContext.response;
        const result = response?.body?.singleResult;
        if (!result) {
          return;
        }

        const req = requestContext.contextValue; // From apolloExpressMiddlewareOptions context()

        req.endAt = req.endAt || new Date();
        const executionTime = req.endAt - req.startAt;
        req.res.set('Execution-Time', executionTime);

        // This will never happen for logged-in users as cacheKey is not set
        if (req.cacheKey && !response?.errors && executionTime > minExecutionTimeToCache) {
          cache.set(req.cacheKey, result, Number(config.graphql.cache.ttl));
        }
      },
    };
  },
};

const resolverTimeDebugWarning = parseInt(config.graphql?.resolverTimeDebugWarning || '200');

export const apolloSlowResolverDebugPlugin = enablePluginIf(config.env === 'development', {
  async requestDidStart() {
    return {
      async executionDidStart(executionRequestContext) {
        const slow = [];
        return {
          willResolveField({ info }) {
            const start = process.hrtime.bigint();
            return () => {
              const end = process.hrtime.bigint();
              slow.push({
                timeMs: round(Number(end - start) / 1e6, 2),
                field: `${info.parentType.name}.${info.fieldName}`,
              });
            };
          },
          executionDidEnd() {
            uniqBy(orderBy(slow, ['timeNs'], ['desc']), 'field')
              .filter(s => s.timeMs >= resolverTimeDebugWarning)
              .forEach(s => {
                logger.warn(
                  `${executionRequestContext.operation.name.value} slow fields: ${s.field} took ${Number(s.timeMs)}ms`,
                );
              });
          },
        };
      },
    };
  },
});

const IGNORED_ERRORS = [ContentNotReady, AxiosError];

export const apolloStudioUsagePlugin = enablePluginIf(
  !isNil(config.graphql?.apollo?.graphRef),
  ApolloServerPluginUsageReporting({
    generateClientInfo: args => {
      return {
        clientName: args.request.http?.headers.get('oc-application') || 'unknown',
        clientVersion: args.request.http?.headers.get('oc-version') || 'unknown',
      };
    },
    sendErrors: {
      transform: err => {
        if (IGNORED_ERRORS.some(e => err instanceof e || err?.originalError instanceof e)) {
          return null;
        }

        return Object.assign({}, err, { originalError: undefined } as Partial<GraphQLError>);
      },
    },
    sendVariableValues: {
      transform: ({ variables }) => {
        return pick(variables, ['slug', 'account', 'fromAccount', 'toAccount', 'id']);
      },
    },
  }),
);
