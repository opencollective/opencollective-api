import assert from 'assert';

import { AggregationsMultiBucketAggregateBase, SearchResponse } from '@elastic/elasticsearch/lib/api/types';
import DataLoader from 'dataloader';
import { groupBy, pick } from 'lodash';

import { formatIndexNameForElasticSearch } from '../../lib/elastic-search/common';
import { ElasticSearchIndexName, ElasticSearchIndexParams } from '../../lib/elastic-search/constants';
import { elasticSearchGlobalSearch, ElasticSearchIndexRequest } from '../../lib/elastic-search/search';
import { reportMessageToSentry } from '../../lib/sentry';
import { Collective } from '../../models';

type SearchParams = {
  requestId: string;
  searchTerm: string;
  index: ElasticSearchIndexName;
  indexParams: ElasticSearchIndexParams[ElasticSearchIndexName];
  forbidPrivate?: boolean;
  limit: number;
  adminOfAccountIds: number[];
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

export type SearchResult = {
  count: number;
  maxScore: number;
  hits: Array<{
    indexName: ElasticSearchIndexName;
    score: number;
    id: string;
    source: Record<string, unknown>;
    highlight: Record<string, string[]>;
  }>;
};

const getSearchIndexes = (requests: SearchParams[]): ElasticSearchIndexRequest[] => {
  const results: Partial<Record<ElasticSearchIndexName, ElasticSearchIndexRequest>> = {};
  for (const request of requests) {
    if (!results[request.index]) {
      results[request.index] = pick(request, ['index', 'indexParams', 'forbidPrivate']);
    }
  }

  return Object.values(results);
};

/**
 * A loader to batch search requests on multiple indexes into a single ElasticSearch query.
 */
export const generateSearchLoaders = req => {
  return new DataLoader<SearchParams, SearchResult | null>(async (requests: SearchParams[]) => {
    const groupedRequests = groupBy(requests, 'requestId');
    const requestsResults = new Map<string, SearchResponse>();
    const failures = [];

    // All grouped requests must have the same searchTerm
    assert(
      Object.values(groupedRequests).every(group => new Set(group.map(entry => entry.searchTerm)).size === 1),
      'All requests must have the same searchTerm',
    );

    // Go through all the search request (one `search` field in the query = one request)
    for (const requestId in groupedRequests) {
      const firstRequest = groupedRequests[requestId][0];
      const { searchTerm, limit, account, host } = firstRequest;
      const indexes = getSearchIndexes(groupedRequests[requestId]);
      const results = await elasticSearchGlobalSearch(indexes, searchTerm, {
        user: req.remoteUser,
        account,
        host,
        limit,
      });

      if (results) {
        requestsResults.set(requestId, results);
        if (results._shards?.failures) {
          failures.push({ request: firstRequest, indexes, items: results._shards.failures });
        }
      }
    }

    if (failures.length > 0) {
      reportMessageToSentry('ElasticSearch shard failures', { extra: { failures } });
    }

    return requests.map(request => {
      const results = requestsResults.get(request.requestId);
      const resultsAggregationsByIndex = results?.aggregations?.by_index as AggregationsMultiBucketAggregateBase;
      const buckets = resultsAggregationsByIndex?.buckets as Array<SearchResultBucket>;
      if (!buckets) {
        return null;
      }

      const expectedBucket = formatIndexNameForElasticSearch(request.index);
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
    });
  });
};
