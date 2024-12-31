import { CollectiveType } from '../../constants/collectives';

export enum ElasticSearchIndexName {
  COLLECTIVES = 'collectives',
  COMMENTS = 'comments',
  EXPENSES = 'expenses',
  UPDATES = 'updates',
  TRANSACTIONS = 'transactions',
  ORDERS = 'orders',
  TIERS = 'tiers',
  HOST_APPLICATIONS = 'host-applications',
}

export interface ElasticSearchIndexParams extends Record<ElasticSearchIndexName, Record<string, unknown>> {
  [ElasticSearchIndexName.COLLECTIVES]: {
    type?: CollectiveType;
    isHost?: boolean;
    tags?: string[];
    isActive?: boolean;
  };
}
