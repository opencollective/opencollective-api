import { CollectiveType } from '../../constants/collectives';

export enum OpenSearchIndexName {
  COLLECTIVES = 'collectives',
  COMMENTS = 'comments',
  EXPENSES = 'expenses',
  UPDATES = 'updates',
  TRANSACTIONS = 'transactions',
  ORDERS = 'orders',
  TIERS = 'tiers',
  HOST_APPLICATIONS = 'host-applications',
}

export interface OpenSearchIndexParams extends Record<OpenSearchIndexName, Record<string, unknown>> {
  [OpenSearchIndexName.COLLECTIVES]: {
    type?: CollectiveType;
    isHost?: boolean;
    tags?: string[];
  };
}
