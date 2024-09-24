import { AggregationsMultiBucketAggregateBase, SearchResponse } from '@elastic/elasticsearch/lib/api/types';
import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

import { getElasticSearchClient } from '../../lib/elastic-search/client';
import { Collective } from '../../models';

type SearchParams = {
  requestId: string;
  searchTerm: string;
  index: string;
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

export const generateSearchLoaders = () => {
  return new DataLoader<SearchParams, SearchResultBucket>(async (entries: SearchParams[]) => {
    const client = getElasticSearchClient({ throwIfUnavailable: true });
    const groupedRequests = groupBy(entries, 'requestId');
    const requestsResults = new Map<string, SearchResponse>();

    // All grouped requests must have the same searchTerm
    const allRequestsHaveTheSameId = Object.values(groupedRequests).every(
      group => new Set(group.map(entry => entry.searchTerm)).size === 1,
    );
    if (!allRequestsHaveTheSameId) {
      throw new Error('All requests must have the same searchTerm');
    }
    for (const requestId in groupedRequests) {
      const searchTerm = groupedRequests[requestId][0].searchTerm;
      const limit = groupedRequests[requestId][0].limit;
      const indexes = groupedRequests[requestId].map(entry => entry.index);
      const adminOfAccountIds = groupedRequests[requestId][0].adminOfAccountIds;
      const account = groupedRequests[requestId][0].account;
      const host = groupedRequests[requestId][0].host;

      const allCols = [
        'id',
        'name',
        'slug',
        'description',
        'html',
        'longDescription',
        'legalName',
        'merchantId',
        'uuid',
      ];
      const results = await client.search({
        /* eslint-disable camelcase */
        index: indexes.join(','),
        body: {
          size: 0, // We don't need hits at the top level
          query: {
            multi_match: {
              query: searchTerm,
              fields: allCols,
              type: 'best_fields',
              operator: 'or',
              fuzziness: 'AUTO',
            },
          },
          aggs: {
            by_index: {
              terms: {
                field: '_index',
                size: indexes.length, // Make sure we get all indexes
              },
              aggs: {
                top_hits_by_index: {
                  top_hits: {
                    size: limit,
                    _source: {
                      includes: allCols,
                    },
                    highlight: {
                      pre_tags: ['<em>'],
                      post_tags: ['</em>'],
                      fragment_size: 150,
                      number_of_fragments: 3,
                      fields: allCols.reduce((acc, field) => {
                        acc[field] = {};
                        return acc;
                      }, {}),
                    },
                  },
                },
              },
            },
          },
        },
        /* eslint-enable camelcase */
      });

      requestsResults.set(requestId, results);
    }

    return entries.map(entry => {
      const results = requestsResults.get(entry.requestId);
      const resultsAggregationsByIndex = results.aggregations.by_index as AggregationsMultiBucketAggregateBase;
      const buckets = resultsAggregationsByIndex.buckets as Array<SearchResultBucket>;
      return buckets.find(bucket => bucket.key === entry.index);
    });
  });
};
