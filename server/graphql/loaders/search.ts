import { Client } from '@elastic/elasticsearch';
import DataLoader from 'dataloader';
import { groupBy } from 'lodash';

type SearchParams = {
  requestId: string;
  searchTerm: string;
  index: string;
  limit: number;
};

export const generateSearchLoaders = () => {
  return new DataLoader(async (entries: SearchParams[]) => {
    const client = new Client({ node: 'http://localhost:9200' });
    const groupedRequests = groupBy(entries, 'requestId');
    const requestsResults = new Map();

    // All grouped requests must have the same searchTerm
    const isOk = Object.values(groupedRequests).every(
      group => new Set(group.map(entry => entry.searchTerm)).size === 1,
    );
    if (!isOk) {
      throw new Error('All requests must have the same searchTerm');
    }
    for (const requestId in groupedRequests) {
      const searchTerm = groupedRequests[requestId][0].searchTerm;
      const limit = groupedRequests[requestId][0].limit;
      const indexes = groupedRequests[requestId].map(entry => entry.index);

      const results = await client.search({
        index: indexes.join(','),
        body: {
          size: 0, // We don't need hits at the top level
          query: {
            multi_match: {
              query: searchTerm,
              fields: ['name', 'description', 'html', 'longDescription', 'legalName'],
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
                      includes: ['name', 'description', 'html', 'longDescription', 'legalName'],
                    },
                    highlight: {
                      fields: {
                        name: {},
                        description: {},
                        html: {},
                        longDescription: {},
                        legalName: {},
                      },
                      pre_tags: ['<em>'],
                      post_tags: ['</em>'],
                      fragment_size: 150,
                      number_of_fragments: 3,
                    },
                  },
                },
              },
            },
          },
        },
      });

      requestsResults.set(requestId, results);
    }

    return entries.map(entry => {
      const results = requestsResults.get(entry.requestId);
      return results.aggregations.by_index.buckets.find(bucket => bucket.key === entry.index);
    });
  });
};
