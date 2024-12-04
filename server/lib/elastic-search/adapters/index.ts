import { ElasticSearchIndexName } from '../constants';

import { ElasticSearchCollectivesAdapter } from './ElasticSearchCollectivesAdapter';
import { ElasticSearchCommentsAdapter } from './ElasticSearchCommentsAdapter';
import { ElasticSearchExpensesAdapter } from './ElasticSearchExpensesAdapter';
import { ElasticSearchHostApplicationsAdapter } from './ElasticSearchHostApplicationsAdapter';
import { ElasticSearchModelAdapter } from './ElasticSearchModelAdapter';
import { ElasticSearchOrdersAdapter } from './ElasticSearchOrdersAdapter';
import { ElasticSearchTiersAdapter } from './ElasticSearchTiersAdapter';
import { ElasticSearchTransactionsAdapter } from './ElasticSearchTransactionsAdapter';
import { ElasticSearchUpdatesAdapter } from './ElasticSearchUpdatesAdapter';

export const ElasticSearchModelsAdapters: Record<ElasticSearchIndexName, ElasticSearchModelAdapter> = {
  [ElasticSearchIndexName.COLLECTIVES]: new ElasticSearchCollectivesAdapter(),
  [ElasticSearchIndexName.COMMENTS]: new ElasticSearchCommentsAdapter(),
  [ElasticSearchIndexName.EXPENSES]: new ElasticSearchExpensesAdapter(),
  [ElasticSearchIndexName.HOST_APPLICATIONS]: new ElasticSearchHostApplicationsAdapter(),
  [ElasticSearchIndexName.ORDERS]: new ElasticSearchOrdersAdapter(),
  [ElasticSearchIndexName.TIERS]: new ElasticSearchTiersAdapter(),
  [ElasticSearchIndexName.TRANSACTIONS]: new ElasticSearchTransactionsAdapter(),
  [ElasticSearchIndexName.UPDATES]: new ElasticSearchUpdatesAdapter(),
} as const;

const AdaptersFromTableNames: Record<string, ElasticSearchModelAdapter> = Object.values(
  ElasticSearchModelsAdapters,
).reduce(
  (acc, adapter) => {
    acc[adapter.model.tableName] = adapter;
    return acc;
  },
  {} as Record<string, ElasticSearchModelAdapter>,
);

export const getAdapterFromTableName = (table: string): ElasticSearchModelAdapter | undefined => {
  return AdaptersFromTableNames[table];
};
