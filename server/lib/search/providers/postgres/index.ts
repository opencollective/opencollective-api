/**
 * PostgreSQL implementation of the search provider contract: searches source tables directly, with one adapter per
 * entity (`adapters/`). Matching, score encoding and execution budgets are shared by all entities.
 */

import config from 'config';
import pMap from 'p-map';

import { UnexpectedError } from '../../../../graphql/errors';
import { reportErrorToSentry } from '../../../sentry';
import { SearchEntityRequest, SearchEntityResult, SearchProviderImplementation, SearchRequest } from '../../types';

import type { PostgresSearchAccess } from './adapters/types';
import { getPostgresSearchAdapter } from './adapters';
import { SearchTooBroadError, UnsupportedSearchEntityError } from './errors';
import { runWithSearchBudget, SearchBudgetExceeded } from './execution';
import {
  assertValidSearchPage,
  assertValidSearchTerm,
  assertValidSearchTimeout,
  ParsedSearchInput,
  parseSearchInput,
} from './input';
import { executeRankedSearchQuery } from './query-builder';

const EMPTY_RESULT: SearchEntityResult = { totalCount: 0, maxScore: 0, hits: [] };

const getAccess = (request: SearchRequest, entityRequest: SearchEntityRequest): PostgresSearchAccess => {
  const { remoteUser } = request;
  if (!remoteUser || entityRequest.forbidPrivate) {
    return { forbidPrivate: true, isRoot: false, adminIds: [] };
  }

  return { forbidPrivate: false, isRoot: remoteUser.isRoot(), adminIds: remoteUser.getAdministratedCollectiveIds() };
};

const searchEntity = async (
  request: SearchRequest,
  input: ParsedSearchInput,
  entityRequest: SearchEntityRequest,
  deadline: number,
): Promise<SearchEntityResult> => {
  const adapter = getPostgresSearchAdapter(entityRequest.entity);
  if (!adapter) {
    throw new UnsupportedSearchEntityError(entityRequest.entity);
  }

  assertValidSearchPage(entityRequest);
  if (!input.term) {
    return EMPTY_RESULT; // Empty input: no unbounded browsing
  }

  try {
    return await runWithSearchBudget({ deadline }, trx => {
      const arms = adapter.buildArms(trx, {
        input,
        scope: { accountId: request.scope.account?.id ?? null, hostId: request.scope.host?.id ?? null },
        access: getAccess(request, entityRequest),
        params: entityRequest.params,
      });

      return executeRankedSearchQuery(trx, arms, entityRequest);
    });
  } catch (error) {
    if (error instanceof SearchBudgetExceeded) {
      throw new SearchTooBroadError(entityRequest.entity);
    }

    reportErrorToSentry(error, { extra: { entity: entityRequest.entity } });
    throw new UnexpectedError('The PostgreSQL search failed, please try again later', 'SearchFailed');
  }
};

export const PostgresProvider: SearchProviderImplementation = {
  assertAvailable() {
    // Uses the main database: always available
  },
  validateRequest(request) {
    assertValidSearchTerm(request.term);
    assertValidSearchTimeout(request.timeoutInMs);
  },
  async search(request, entityRequests) {
    // `timeoutInMs` is the budget of the whole search: no entity query starts (or keeps running) after it
    const deadline = Date.now() + request.timeoutInMs;
    const input = parseSearchInput(request.term);
    const concurrency = Number(config.search.postgres.concurrencyPerRequest);
    return pMap(
      entityRequests,
      async entityRequest => {
        try {
          return await searchEntity(request, input, entityRequest, deadline);
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      },
      { concurrency },
    );
  },
};
