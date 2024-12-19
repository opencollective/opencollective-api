import config from 'config';

import { ElasticSearchIndexName } from './constants';

const getIndexesPrefix = () => config.elasticSearch?.indexesPrefix;

/**
 * Formats the index name before querying ElasticSearch. Allows to share a single ElasticSearch
 * instance between multiple environments (e.g. staging and production, dev and test).
 */
export const formatIndexNameForElasticSearch = (indexName: ElasticSearchIndexName): string => {
  const prefix = getIndexesPrefix();
  if (prefix) {
    return `${prefix}_${indexName}`;
  } else {
    return indexName;
  }
};
