import assert from 'assert';

import { AggregationsMultiBucketAggregateBase, SearchResponse } from '@elastic/elasticsearch/lib/api/types';
import DataLoader from 'dataloader';
import { groupBy, pick } from 'lodash';

import { ElasticSearchIndexName, ElasticSearchIndexParams } from '../../lib/elastic-search/constants';
import { elasticSearchGlobalSearch, ElasticSearchIndexRequest } from '../../lib/elastic-search/search';
import { reportMessageToSentry } from '../../lib/sentry';
import { Collective } from '../../models';

type SearchParams = {
  requestId: string;
  searchTerm: string;
  index: string;
  indexParams: ElasticSearchIndexParams[ElasticSearchIndexName];
  limit: number;
  adminOfAccountIds: number[];
  account: Collective;
  host: Collective;
};

export type SearchResultBucket = {
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

const getSearchIndexes = (requests: SearchParams[]): ElasticSearchIndexRequest[] => {
  const results: Partial<Record<ElasticSearchIndexName, ElasticSearchIndexRequest>> = {};
  for (const request of requests) {
    if (!results[request.index]) {
      results[request.index] = pick(request, ['index', 'indexParams']);
    }
  }

  return Object.values(results);
};

/**
 * A loader to batch search requests on multiple indexes into a single ElasticSearch query.
 */
export const generateSearchLoaders = req => {
  return new DataLoader<SearchParams, SearchResultBucket>(async (entries: SearchParams[]) => {
    const groupedRequests = groupBy(entries, 'requestId');
    const requestsResults = new Map<string, SearchResponse>();

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
        if (results._shards?.failures) {
          reportMessageToSentry('ElasticSearch search shard failures', {
            extra: {
              failures: results._shards.failures,
              request: firstRequest,
              indexes,
            },
          });
        }

        requestsResults.set(requestId, results);
      }
    }

    return entries.map(entry => {
      const results = requestsResults.get(entry.requestId);
      const resultsAggregationsByIndex = results?.aggregations?.by_index as AggregationsMultiBucketAggregateBase;
      const buckets = resultsAggregationsByIndex?.buckets as Array<SearchResultBucket>;
      if (!buckets) {
        return null;
      }

      return buckets.find(bucket => bucket.key === entry.index);
    });
  });
};
