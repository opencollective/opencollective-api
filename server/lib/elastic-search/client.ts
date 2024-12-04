import { Client } from '@elastic/elasticsearch';
import config from 'config';

export const isElasticSearchConfigured = (): boolean => !!config.elasticSearch?.url;

export const getElasticSearchClient = ({ throwIfUnavailable = false } = {}): Client | undefined => {
  if (isElasticSearchConfigured()) {
    return new Client({ node: config.elasticSearch.url });
  } else if (throwIfUnavailable) {
    throw new Error('ElasticSearch is not configured');
  }
};
