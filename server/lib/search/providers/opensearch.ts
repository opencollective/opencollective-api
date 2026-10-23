/**
 * OpenSearch implementation of the search provider contract. Matching, scoring and permissions are unchanged and
 * live in `server/lib/open-search/search.ts`.
 */

import { ResponseBody } from '@opensearch-project/opensearch/api/_types/_core.search.js';
import config from 'config';
import { max } from 'lodash';

import { isOpenSearchConfigured } from '../../open-search/client';
import { formatIndexNameForOpenSearch } from '../../open-search/common';
import { OpenSearchIndexName } from '../../open-search/constants';
import {
  OpenSearchIndexRequest,
  openSearchMultiIndexGlobalSearch,
  openSearchSingleIndexSearch,
} from '../../open-search/search';
import { reportMessageToSentry } from '../../sentry';
import {
  SearchEntity,
  SearchEntityRequest,
  SearchEntityResult,
  SearchHit,
  SearchProviderImplementation,
  SearchRequest,
} from '../types';

const IndexNameByEntity: Record<SearchEntity, OpenSearchIndexName> = {
  [SearchEntity.ACCOUNTS]: OpenSearchIndexName.COLLECTIVES,
  [SearchEntity.COMMENTS]: OpenSearchIndexName.COMMENTS,
  [SearchEntity.EXPENSES]: OpenSearchIndexName.EXPENSES,
  [SearchEntity.HOST_APPLICATIONS]: OpenSearchIndexName.HOST_APPLICATIONS,
  [SearchEntity.ORDERS]: OpenSearchIndexName.ORDERS,
  [SearchEntity.TIERS]: OpenSearchIndexName.TIERS,
  [SearchEntity.TRANSACTIONS]: OpenSearchIndexName.TRANSACTIONS,
  [SearchEntity.UPDATES]: OpenSearchIndexName.UPDATES,
};

type OpenSearchHit = {
  _id?: string;
  _score?: number | string | null;
  _source?: Record<string, unknown>;
  highlight?: Record<string, string[]>;
};

type TopHitsBucket = {
  key: string;
  // eslint-disable-next-line camelcase
  doc_count: number;
  // eslint-disable-next-line camelcase
  top_hits_by_index: { hits: { max_score: number | null; hits: OpenSearchHit[] } };
};

const toIndexRequest = (entityRequest: SearchEntityRequest): OpenSearchIndexRequest => ({
  index: IndexNameByEntity[entityRequest.entity],
  indexParams: entityRequest.params,
  forbidPrivate: entityRequest.forbidPrivate,
});

const toSearchHit = (hit: OpenSearchHit): SearchHit => ({
  id: Number(hit._source['id']),
  uuid: hit._source['uuid'] as string | undefined,
  score: typeof hit._score === 'string' ? parseFloat(hit._score) : hit._score,
  highlight: hit.highlight,
});

/**
 * In top hits mode, all entities of a search are ranked in a single multi-index query. An index can only appear
 * once per query, so entity requests that target the same index with different filters or pages (aliases) are
 * spread over several queries.
 */
const splitInTopHitsQueries = (entityRequests: SearchEntityRequest[]): SearchEntityRequest[][] => {
  const queries: SearchEntityRequest[][] = [];
  for (const entityRequest of entityRequests) {
    const query = queries.find(
      requests => requests[0].offset === entityRequest.offset && requests.every(r => r.entity !== entityRequest.entity),
    );
    if (query) {
      query.push(entityRequest);
    } else {
      queries.push([entityRequest]);
    }
  }

  return queries;
};

const searchWithTopHits = async (
  request: SearchRequest,
  entityRequests: SearchEntityRequest[],
): Promise<Map<SearchEntityRequest, SearchEntityResult | null>> => {
  const results = new Map<SearchEntityRequest, SearchEntityResult | null>();
  const failures = [];
  for (const queryRequests of splitInTopHitsQueries(entityRequests)) {
    // Fetch enough hits for the largest page, then slice each entity to its own limit
    const indexesRequests = queryRequests.map(toIndexRequest);
    const response = await openSearchMultiIndexGlobalSearch(indexesRequests, request.term, {
      user: request.remoteUser,
      isRoot: request.isRoot,
      account: request.scope.account,
      host: request.scope.host,
      limit: max(queryRequests.map(r => r.limit)),
      offset: queryRequests[0].offset,
    });

    const body: ResponseBody = response?.body;
    if (body?._shards?.failures) {
      failures.push({ request, indexes: indexesRequests, items: body._shards.failures });
    }

    const buckets = body?.aggregations?.by_index?.['buckets'] as TopHitsBucket[] | undefined;
    for (const entityRequest of queryRequests) {
      const expectedBucket = formatIndexNameForOpenSearch(IndexNameByEntity[entityRequest.entity]);
      const bucket = buckets?.find(bucket => bucket.key === expectedBucket);
      results.set(
        entityRequest,
        !bucket
          ? null
          : {
              totalCount: bucket.doc_count,
              maxScore: bucket.top_hits_by_index.hits.max_score || 0,
              hits: bucket.top_hits_by_index.hits.hits.slice(0, entityRequest.limit).map(toSearchHit),
            },
      );
    }
  }

  if (failures.length > 0) {
    reportMessageToSentry('OpenSearch shard failures', { extra: { failures } });
  }

  return results;
};

const searchSeparately = async (
  request: SearchRequest,
  entityRequests: SearchEntityRequest[],
): Promise<Map<SearchEntityRequest, SearchEntityResult | null>> => {
  const results = new Map<SearchEntityRequest, SearchEntityResult | null>();
  for (const entityRequest of entityRequests) {
    const response = await openSearchSingleIndexSearch(toIndexRequest(entityRequest), request.term, {
      user: request.remoteUser,
      isRoot: request.isRoot,
      account: request.scope.account,
      host: request.scope.host,
      limit: entityRequest.limit,
      offset: entityRequest.offset,
    });

    const hits = response?.body?.hits;
    results.set(
      entityRequest,
      !hits
        ? null
        : {
            totalCount: typeof hits.total === 'number' ? hits.total : hits.total.value,
            maxScore: (typeof hits.max_score === 'string' ? parseFloat(hits.max_score) : hits.max_score) || 0,
            hits: hits.hits.map(toSearchHit),
          },
    );
  }

  return results;
};

/**
 * `SearchRequest.timeoutInMs` is not forwarded: OpenSearch queries keep their own default timeout.
 */
export const OpenSearchProvider: SearchProviderImplementation = {
  assertAvailable() {
    if (!isOpenSearchConfigured()) {
      throw new Error(
        config.env === 'development' ? 'OpenSearch is not running' : 'The search is temporarily unavailable',
      );
    }
  },
  async search(request, entityRequests) {
    const results = request.useTopHits
      ? await searchWithTopHits(request, entityRequests)
      : await searchSeparately(request, entityRequests);

    return entityRequests.map(entityRequest => results.get(entityRequest) ?? null);
  },
};
