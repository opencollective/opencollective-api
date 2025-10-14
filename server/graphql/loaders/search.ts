import assert from 'assert';

import { ResponseBody } from '@opensearch-project/opensearch/api/_types/_core.search';
import config from 'config';
import DataLoader from 'dataloader';
import { groupBy, pick } from 'lodash';

import { formatIndexNameForOpenSearch } from '../../lib/open-search/common';
import { OpenSearchIndexName, OpenSearchIndexParams } from '../../lib/open-search/constants';
import {
  OpenSearchIndexRequest,
  openSearchMultiIndexGlobalSearch,
  openSearchSingleIndexSearch,
} from '../../lib/open-search/search';
import { reportMessageToSentry } from '../../lib/sentry';
import { Collective } from '../../models';

type LoaderSearchParams = {
  requestId: string;
  useTopHits: boolean;
  searchTerm: string;
  index: OpenSearchIndexName;
  indexParams: OpenSearchIndexParams[OpenSearchIndexName];
  forbidPrivate?: boolean;
  limit: number;
  offset: number;
  account: Collective;
  host: Collective;
};

type SearchResultBucket = {
  key: string;
  doc_count: number;
  top_hits_by_index: {
    hits: {
      total: {
        value: number;
        relation: string;
      };
      max_score: number | null;
      hits: Array<{
        _index: string;
        _id: string;
        _score: number;
        _source: Record<string, unknown>;
        highlight: Record<string, string[]>;
      }>;
    };
  };
};

type SearchResult = {
  count: number;
  maxScore: number;
  hits: Array<{
    indexName: OpenSearchIndexName;
    score: number;
    id: string;
    source: Record<string, unknown>;
    highlight: Record<string, string[]>;
  }>;
};

const getSearchIndexes = (requests: LoaderSearchParams[]): OpenSearchIndexRequest[] => {
  const results: Partial<Record<OpenSearchIndexName, OpenSearchIndexRequest>> = {};
  for (const request of requests) {
    if (!results[request.index]) {
      results[request.index] = pick(request, ['index', 'indexParams', 'forbidPrivate']);
    }
  }

  return Object.values(results);
};

/**
 * A loader to batch search requests on multiple indexes into a single query.
 */
export const generateSearchLoaders = req => {
  return new DataLoader<LoaderSearchParams, SearchResult | null>(async (requests: LoaderSearchParams[]) => {
    if (requests.length > parseInt(config.limits.search.concurrentRequests)) {
      throw new Error('Too many concurrent search requests');
    }

    const groupedRequests = groupBy(requests, 'requestId');
    const multiIndexSearchResults = new Map<string, ResponseBody>();
    const singleIndexSearchResults = new Map<string, Map<OpenSearchIndexName, ResponseBody>>();
    const failures = [];

    // All grouped requests must have the same searchTerm
    assert(
      Object.values(groupedRequests).every(group => new Set(group.map(entry => entry.searchTerm)).size === 1),
      'All requests must have the same searchTerm',
    );

    // Go through all the search request (one `search` field in the query = one request)
    for (const requestId in groupedRequests) {
      const firstRequest = groupedRequests[requestId][0];
      const { searchTerm, limit, offset, account, host } = firstRequest;
      const indexesRequests = getSearchIndexes(groupedRequests[requestId]);

      if (firstRequest.useTopHits) {
        const response = await openSearchMultiIndexGlobalSearch(indexesRequests, searchTerm, {
          user: req.remoteUser,
          account,
          host,
          limit,
          offset,
        });

        const results = response?.body;
        if (results) {
          multiIndexSearchResults.set(requestId, results);
          if (results._shards?.failures) {
            failures.push({ request: firstRequest, indexes: indexesRequests, items: results._shards.failures });
          }
        }
      } else {
        for (const indexRequest of indexesRequests) {
          const response = await openSearchSingleIndexSearch(indexRequest, searchTerm, {
            user: req.remoteUser,
            account,
            host,
            limit,
            offset,
          });

          const results = response?.body;
          if (results) {
            const existingResults =
              singleIndexSearchResults.get(requestId) || new Map<OpenSearchIndexName, ResponseBody>();
            existingResults.set(indexRequest.index, results);
            singleIndexSearchResults.set(requestId, existingResults);
          }
        }
      }
    }

    if (failures.length > 0) {
      reportMessageToSentry('OpenSearch shard failures', { extra: { failures } });
    }

    return requests.map(request => {
      if (request.useTopHits) {
        const results = multiIndexSearchResults.get(request.requestId);
        const resultsAggregationsByIndex = results?.aggregations?.by_index;
        const buckets = resultsAggregationsByIndex?.['buckets'] as Array<SearchResultBucket>;
        if (!buckets) {
          return null;
        }

        const expectedBucket = formatIndexNameForOpenSearch(request.index);
        const bucket = buckets.find(bucket => bucket.key === expectedBucket);
        if (bucket) {
          return {
            count: bucket.doc_count,
            maxScore: bucket.top_hits_by_index.hits.max_score || 0,
            hits: bucket.top_hits_by_index.hits.hits.map(hit => ({
              indexName: request.index,
              score: hit._score,
              id: hit._id,
              source: hit._source,
              highlight: hit.highlight,
            })),
          };
        }
      } else {
        const hits = singleIndexSearchResults.get(request.requestId)?.get(request.index)?.hits;
        if (hits) {
          return {
            count: typeof hits.total === 'number' ? hits.total : hits.total.value,
            maxScore: (typeof hits.max_score === 'string' ? parseInt(hits.max_score, 10) : hits.max_score) || 0,
            hits: hits.hits.map(hit => ({
              indexName: request.index,
              score: typeof hit._score === 'string' ? parseInt(hit._score, 10) : hit._score,
              id: hit._id,
              source: hit._source,
              highlight: hit.highlight,
            })),
          };
        }
      }
    });
  });
};
