/**
 * Runs the query cost analyzer on every GraphQL request (V1 and V2), next to GraphQL Armor.
 *
 * - The cost of every operation is recorded as a Sentry metric (`internal.opencollective.api.graphql_query_cost`),
 *   with the operation name and the client as attributes, and on the root span of sampled traces.
 * - Operations above `config.graphql.cost.max` (`GRAPHQL_COST_MAX`) get one Sentry report per request.
 * - With `config.graphql.cost.reject` (`GRAPHQL_COST_REJECT`, off by default), they are also rejected with an
 *   HTTP 400. Otherwise they go through (log-only mode).
 * - On GraphQL V2, a `limit` above the maximum of its field (`DEFAULT_MAX_LIMIT`, or `extensions.cost.maxLimit`) gets
 *   one Sentry report per request. With `config.graphql.cost.maxLimit.reject` (`GRAPHQL_COST_MAX_LIMIT_REJECT`, off by
 *   default), it is also rejected with an HTTP 400 naming the field. Root users are exempt. See
 *   opencollective/opencollective#9087.
 * - A failure of the analyzer is reported and never fails the request.
 *
 * It runs on `didResolveOperation` rather than as a validation rule, because the cost depends on the variables
 * (`limit: $limit`), which validation does not know. See opencollective/opencollective#9081.
 */

import type { ApolloServerPlugin, GraphQLRequestContextDidResolveOperation } from '@apollo/server';
import { GraphQLError } from 'graphql';
import { orderBy } from 'lodash';

import { HandlerType, reportErrorToSentry, reportMessageToSentry, Sentry } from '../../lib/sentry';
import { recordGraphQLQueryCost } from '../../lib/sentry/metrics';
import { isRemoteUserRoot } from '../common/scope-check';

import { getQueryCost } from './index';
import { getMaxLimitSettings, getQueryCostSettings } from './settings';

/** Rejected queries can be up to the size of the body limit, only the beginning is sent to Sentry */
const MAX_QUERY_LENGTH_IN_REPORT = 10_000;

/** Operation names are GraphQL names, but of any length */
const MAX_OPERATION_NAME_LENGTH = 100;

/** Number of top-level fields included in the Sentry report, the most expensive first */
const MAX_FIELDS_IN_REPORT = 20;

/** Number of limits above their maximum named in the error message */
const MAX_LIMIT_VIOLATIONS_IN_MESSAGE = 5;

/** Values accepted from the `oc-application` header, which any client can set */
const CLIENT_APPLICATION_REGEX = /^[a-z0-9][a-z0-9._-]{0,49}$/i;

type RequestContext = GraphQLRequestContextDidResolveOperation<Express.Request>;

type QueryCostResult = ReturnType<typeof getQueryCost>;

/**
 * Identifies the client of a request, to group costs: `oauth:<ApplicationId>` for OAuth applications,
 * `personal-token:<id>` for personal tokens, otherwise the `oc-application` header set by our own services
 * (frontend, rest, pdf, images...), otherwise `unknown`.
 */
const getGraphQLClient = (req: Express.Request, application: string | undefined): string => {
  if (req?.userToken) {
    return `oauth:${req.userToken.ApplicationId}`;
  } else if (req?.personalToken) {
    return `personal-token:${req.personalToken.id}`;
  }

  if (application && CLIENT_APPLICATION_REGEX.test(application)) {
    return application.toLowerCase();
  }

  return 'unknown';
};

const getApiVersion = (req: Express.Request): 'v1' | 'v2' => (req?.baseUrl === '/graphql/v1' ? 'v1' : 'v2');

/** Adds the cost to the root span, to correlate it with durations in sampled traces */
const setSpanAttributes = (attributes: Record<string, string | number | boolean>) => {
  const activeSpan = Sentry.getActiveSpan();
  if (activeSpan) {
    Sentry.getRootSpan(activeSpan).setAttributes(attributes);
  }
};

const getRejectionMessage = (result: QueryCostResult, max: number): string => {
  if (result.abortReason) {
    return `Query cost exceeds the maximum of ${max}: the query is too large to analyze (${result.abortReason}).`;
  } else {
    return `Query cost of ${result.cost} exceeds the maximum of ${max}.`;
  }
};

const getLimitRejectionMessage = (violations: QueryCostResult['limitViolations']): string => {
  const messages = violations
    .slice(0, MAX_LIMIT_VIOLATIONS_IN_MESSAGE)
    .map(
      ({ coordinate, limit, maxLimit }) =>
        `The limit of ${limit} on "${coordinate}" exceeds its maximum of ${maxLimit}, please adjust the limit.`,
    );
  if (violations.length > MAX_LIMIT_VIOLATIONS_IN_MESSAGE) {
    messages.push(`And ${violations.length - MAX_LIMIT_VIOLATIONS_IN_MESSAGE} more.`);
  }
  return messages.join(' ');
};

interface CheckContext {
  requestContext: RequestContext;
  result: QueryCostResult;
  client: string;
  application: string | undefined;
  apiVersion: 'v1' | 'v2';
  reportedOperationName: string | null;
}

const getClientReport = ({ requestContext, client, application }: CheckContext) => {
  const req = requestContext.contextValue;
  return {
    id: client,
    application: application?.slice(0, 100),
    oauthApplicationId: req?.userToken?.ApplicationId,
    personalTokenId: req?.personalToken?.id,
  };
};

/**
 * Reports the limits above the maximum of their field, and returns the rejection error in rejection mode. GraphQL V1
 * is not checked: its limits have no documented maximum.
 */
const checkLimits = (checkContext: CheckContext): GraphQLError | null => {
  const { requestContext, result, client, apiVersion, reportedOperationName } = checkContext;
  const req = requestContext.contextValue;
  const violations = result.limitViolations;
  if (apiVersion !== 'v2' || !violations?.length || isRemoteUserRoot(req)) {
    return null;
  }

  const { reject } = getMaxLimitSettings();
  reportMessageToSentry('GraphQL limit exceeded', {
    handler: HandlerType.GQL,
    severity: 'warning',
    transactionName: `GraphQL limit exceeded: ${reportedOperationName || 'Anonymous'}`,
    tags: { mode: reject ? 'reject' : 'log-only', client, apiVersion },
    req,
    extra: {
      operationName: reportedOperationName,
      operationType: result.operationType,
      limitViolations: violations.slice(0, MAX_FIELDS_IN_REPORT),
      client: getClientReport(checkContext),
      query: requestContext.source?.slice(0, MAX_QUERY_LENGTH_IN_REPORT),
    },
  });

  if (!reject) {
    return null;
  }

  return new GraphQLError(getLimitRejectionMessage(violations), {
    extensions: {
      code: 'GRAPHQL_VALIDATION_FAILED',
      limitViolations: violations
        .slice(0, MAX_LIMIT_VIOLATIONS_IN_MESSAGE)
        .map(({ coordinate, limit, maxLimit }) => ({ coordinate, limit, maxLimit })),
      http: { status: 400 },
    },
  });
};

/**
 * Analyzes the operation, records its cost and reports it if above the maximum, then checks its limits. Returns the
 * rejection error, if any: the one about limits first, as it names the field to fix.
 */
const checkQueryCost = (requestContext: RequestContext): GraphQLError | null => {
  const req = requestContext.contextValue;
  const operationName = requestContext.operationName || null;
  const result = getQueryCost(requestContext.schema, requestContext.document, {
    variables: requestContext.request.variables,
    operationName,
  });

  const application = requestContext.request.http?.headers.get('oc-application');
  const client = getGraphQLClient(req, application);
  if (result.error) {
    // An unexpected error inside the analyzer (fails closed with `cost: Infinity`) or an operation it could not find,
    // which Apollo already resolved. In both cases the problem is ours, not the client's: don't block the request.
    reportErrorToSentry(new Error(`GraphQL query cost analysis failed: ${result.error}`), {
      handler: HandlerType.GQL,
      severity: 'error',
      req,
      extra: { operationName, client },
    });
    return null;
  }

  // Operation names come from the client: keep them bounded in metrics and reports
  const reportedOperationName = result.operationName?.slice(0, MAX_OPERATION_NAME_LENGTH) ?? null;
  const { max, reject } = getQueryCostSettings();
  const apiVersion = getApiVersion(req);
  const overMax = result.cost > max;
  recordGraphQLQueryCost({
    cost: result.cost,
    apiVersion,
    operationName: reportedOperationName,
    operationType: result.operationType,
    client,
    overMax,
  });
  setSpanAttributes({
    'graphql.cost': Number.isFinite(result.cost) ? result.cost : -1,
    'graphql.cost.client': client,
    'graphql.cost.over_max': overMax,
  });

  const checkContext: CheckContext = { requestContext, result, client, application, apiVersion, reportedOperationName };
  const limitRejection = checkLimits(checkContext);
  if (!overMax) {
    return limitRejection;
  }

  const mode = reject ? 'reject' : 'log-only';
  reportMessageToSentry('GraphQL query cost exceeded', {
    handler: HandlerType.GQL,
    severity: 'warning',
    transactionName: `GraphQL query cost exceeded: ${reportedOperationName || 'Anonymous'}`,
    tags: { mode, client, apiVersion },
    req,
    extra: {
      operationName: reportedOperationName,
      operationType: result.operationType,
      cost: Number.isFinite(result.cost) ? result.cost : 'Infinity',
      max,
      abortReason: result.abortReason,
      visitedNodes: result.visitedNodes,
      fields: orderBy(result.fields, ['cost'], ['desc']).slice(0, MAX_FIELDS_IN_REPORT),
      client: getClientReport(checkContext),
      query: requestContext.source?.slice(0, MAX_QUERY_LENGTH_IN_REPORT),
    },
  });

  if (limitRejection || !reject) {
    return limitRejection;
  }

  return new GraphQLError(getRejectionMessage(result, max), {
    extensions: {
      code: 'GRAPHQL_VALIDATION_FAILED',
      cost: Number.isFinite(result.cost) ? result.cost : null,
      maxCost: max,
      http: { status: 400 },
    },
  });
};

export const queryCostPlugin: ApolloServerPlugin<Express.Request> = {
  async requestDidStart() {
    return {
      async didResolveOperation(requestContext) {
        let rejection: GraphQLError | null = null;
        try {
          rejection = checkQueryCost(requestContext);
        } catch (error) {
          // Never fail a request because of the analyzer or its reporting
          try {
            reportErrorToSentry(error, {
              handler: HandlerType.GQL,
              severity: 'error',
              req: requestContext.contextValue,
              extra: { operationName: requestContext.operationName, context: 'GraphQL query cost plugin' },
            });
          } catch {
            // Reporting failed too, nothing else we can do
          }
        }

        if (rejection) {
          throw rejection;
        }
      },
    };
  },
};
