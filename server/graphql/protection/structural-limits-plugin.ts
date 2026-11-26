/**
 * Integration of the structural limits (depth, tokens, aliases, directives) in Express and Apollo.
 *
 * By default the limits run in log-only mode: violations are reported to Sentry but requests go through.
 * Set `config.graphql.structuralLimits.reject` (`GRAPHQL_STRUCTURAL_LIMITS_REJECT`) to reject them with an
 * HTTP 400 and the `GRAPHQL_VALIDATION_FAILED` code.
 *
 * Every request that exceeds a limit gets a single Sentry report listing all the exceeded limits.
 */

import type { ApolloServerPlugin } from '@apollo/server';
import config from 'config';
import type { NextFunction, Request, Response } from 'express';
import type { ValidationRule } from 'graphql';

import { HandlerType, reportMessageToSentry } from '../../lib/sentry';
import { parseToBoolean } from '../../lib/utils';

import {
  countTokens,
  createStructuralLimitsValidationRule,
  getComputedStructuralMetrics,
  getStructuralLimitViolations,
  getTokenLimitViolation,
  type StructuralLimitViolation,
} from './structural-limits';

/** Rejected queries can be up to the size of the body limit, only the beginning is sent to Sentry */
const MAX_QUERY_LENGTH_IN_REPORT = 10_000;

const shouldRejectOnStructuralLimits = (): boolean => parseToBoolean(config.graphql.structuralLimits?.reject);

const reportViolations = (
  violations: StructuralLimitViolation[],
  { req, query, operationName }: { req: Express.Request; query: string; operationName?: string | null },
) => {
  const rejected = shouldRejectOnStructuralLimits();
  const limits = violations.map(v => v.limit).join(', ');
  reportMessageToSentry(`GraphQL structural limits exceeded (${limits})`, {
    handler: HandlerType.GQL,
    severity: 'warning',
    transactionName: `GraphQL structural limits exceeded (${limits}): ${operationName || 'Anonymous'}`,
    tags: { mode: rejected ? 'reject' : 'log-only' },
    req,
    extra: {
      operationName,
      violations: violations.map(({ limit, max, found }) => ({ limit, max, found })),
      messages: violations.map(v => v.message),
      query: query?.slice(0, MAX_QUERY_LENGTH_IN_REPORT),
    },
  });
};

/**
 * Express middleware, to mount before Apollo: in rejection mode, rejects queries exceeding the token limit before
 * they are parsed. Apollo turns errors thrown by plugins before parsing into a 500, hence the middleware.
 */
export const structuralLimitsTokenMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const query = req.method === 'GET' ? req.query?.query : req.body?.query;
  if (typeof query !== 'string' || !shouldRejectOnStructuralLimits()) {
    return next();
  }

  const violation = getTokenLimitViolation(countTokens(query));
  if (!violation) {
    return next();
  }

  const operationName = req.method === 'GET' ? req.query?.operationName : req.body?.operationName;
  reportViolations([violation], {
    req,
    query,
    operationName: typeof operationName === 'string' ? operationName : null,
  });
  res.status(400).json({
    errors: [{ message: violation.message, extensions: { code: 'GRAPHQL_VALIDATION_FAILED', limit: violation.limit } }],
  });
};

/** Computes depth, aliases and directives. In rejection mode, reports a validation error per exceeded limit. */
export const structuralLimitsValidationRule: ValidationRule =
  createStructuralLimitsValidationRule(shouldRejectOnStructuralLimits);

/** Reports the exceeded limits of each request to Sentry, once. */
export const structuralLimitsPlugin: ApolloServerPlugin<Express.Request> = {
  async requestDidStart() {
    let tokenViolation: StructuralLimitViolation | null = null;
    return {
      // Runs for every request, including the ones whose document is served from Apollo's cache
      async didResolveSource({ source }) {
        tokenViolation = getTokenLimitViolation(countTokens(source));
      },
      async willSendResponse(requestContext) {
        // Also available for documents served from Apollo's cache, which skips validation
        const metrics = getComputedStructuralMetrics(requestContext.document);
        const violations = [
          ...(tokenViolation ? [tokenViolation] : []),
          ...(metrics ? getStructuralLimitViolations(metrics) : []),
        ];
        if (violations.length) {
          reportViolations(violations, {
            req: requestContext.contextValue,
            query: requestContext.source,
            operationName: requestContext.operationName || requestContext.request.operationName,
          });
        }
      },
    };
  },
};
