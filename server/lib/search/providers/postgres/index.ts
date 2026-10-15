/**
 * PostgreSQL implementation of the search provider contract: searches source tables directly, with one adapter per
 * entity (`adapters/`). Matching, score encoding and execution budgets are shared by all entities.
 */

import config from 'config';
import pMap from 'p-map';

import { UnexpectedError } from '../../../../graphql/errors';
import { reportErrorToSentry } from '../../../sentry';
import { parseToBoolean } from '../../../utils';
import { SearchEntityRequest, SearchEntityResult, SearchProviderImplementation, SearchRequest } from '../../types';

import type { PostgresSearchAccess } from './adapters/types';
import { getPostgresSearchAdapter } from './adapters';
import { SearchTooBroadError, UnsupportedSearchEntityError } from './errors';
import { assertEstimatedMatchesWithinBudget } from './estimates';
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
  const deniedOAuthScopes = entityRequest.deniedOAuthScopes || [];
  if (!remoteUser || entityRequest.forbidPrivate) {
    return { forbidPrivate: true, isRoot: false, adminIds: [], deniedOAuthScopes };
  }

  return {
    forbidPrivate: false,
    isRoot: remoteUser.isRoot(),
    adminIds: remoteUser.getAdministratedCollectiveIds(),
    deniedOAuthScopes,
  };
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
    return await runWithSearchBudget({ deadline }, async (trx, budget) => {
      const arms = adapter.buildArms(trx, {
        input,
        scope: { accountId: request.scope.account?.id ?? null, hostId: request.scope.host?.id ?? null },
        access: getAccess(request, entityRequest),
        params: entityRequest.params,
      });

      // The first statement uses the `statement_timeout` set by `runWithSearchBudget`, later ones renew it
      if (adapter.estimatedMatchesPerSecond) {
        await assertEstimatedMatchesWithinBudget(trx, arms, {
          matchesPerSecond: adapter.estimatedMatchesPerSecond,
          deadline,
        });
        await budget.renewStatementTimeout();
      }

      const result = await executeRankedSearchQuery(trx, arms, entityRequest);
      if (!adapter.decorateHits) {
        return result;
      }

      await budget.renewStatementTimeout();
      return { ...result, hits: await adapter.decorateHits(trx, result.hits) };
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
    // Uses the main database. Can be turned off without a deploy (`SEARCH_POSTGRES_ENABLED=false`): every request then
    // has to use the default backend (OpenSearch).
    if (!parseToBoolean(config.search.postgres.enabled)) {
      throw new Error('The PostgreSQL search is turned off, please use the default search backend');
    }
  },
  validateRequest(request) {
    assertValidSearchTerm(request.term);
    assertValidSearchTimeout(request.timeoutInMs);
  },
  async search(request, entityRequests) {
    const input = parseSearchInput(request.term);
    const concurrency = Number(config.search.postgres.concurrencyPerRequest);
    return pMap(
      entityRequests,
      async entityRequest => {
        // `timeoutInMs` is the budget of each entity query (as documented on `Query.search`), from the moment it is
        // scheduled: waiting for a search slot or a pooled connection counts, waiting for the other entities doesn't
        const deadline = Date.now() + request.timeoutInMs;
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
