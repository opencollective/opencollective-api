import { Client } from '@elastic/elasticsearch';
import config from 'config';

export const getElasticSearchClient = ({ throwIfUnavailable = false } = {}): Client | undefined => {
  if (config.elasticSearch?.url) {
    return new Client({ node: config.elasticSearch.url });
  } else if (throwIfUnavailable) {
    throw new Error('ElasticSearch is not configured');
  }
};
