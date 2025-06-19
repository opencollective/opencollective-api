import { Client } from '@opensearch-project/opensearch';
import config from 'config';

export const isOpenSearchConfigured = (): boolean => !!config.opensearch?.url;

export const getOpenSearchClient = ({ throwIfUnavailable = false } = {}): Client | undefined => {
  if (isOpenSearchConfigured()) {
    return new Client({ node: config.opensearch.url });
  } else if (throwIfUnavailable) {
    throw new Error('OpenSearch is not configured');
  }
};
