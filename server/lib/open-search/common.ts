import config from 'config';

import { OpenSearchIndexName } from './constants';

const getIndexesPrefix = () => config.opensearch?.indexesPrefix;

/**
 * Formats the index name before querying ElasticSearch. Allows to share a single ElasticSearch
 * instance between multiple environments (e.g. staging and production, dev and test).
 */
export const formatIndexNameForOpenSearch = (indexName: OpenSearchIndexName): string => {
  const prefix = getIndexesPrefix();
  if (prefix) {
    return `${prefix}_${indexName}`;
  } else {
    return indexName;
  }
};
