import { OpenSearchIndexName } from '../constants';

import { OpenSearchCollectivesAdapter } from './OpenSearchCollectivesAdapter';
import { ElasticSearchCommentsAdapter } from './ElasticSearchCommentsAdapter';
import { ElasticSearchExpensesAdapter } from './ElasticSearchExpensesAdapter';
import { ElasticSearchHostApplicationsAdapter } from './ElasticSearchHostApplicationsAdapter';
import { OpenSearchModelAdapter } from './ElasticSearchModelAdapter';
import { ElasticSearchOrdersAdapter } from './ElasticSearchOrdersAdapter';
import { OpenSearchTiersAdapter } from './ElasticSearchTiersAdapter';
import { OpenSearchTransactionsAdapter } from './ElasticSearchTransactionsAdapter';
import { ElasticSearchUpdatesAdapter } from './ElasticSearchUpdatesAdapter';

export const OpenSearchModelsAdapters: Record<OpenSearchIndexName, OpenSearchModelAdapter> = {
  [OpenSearchIndexName.COLLECTIVES]: new OpenSearchCollectivesAdapter(),
  [OpenSearchIndexName.COMMENTS]: new ElasticSearchCommentsAdapter(),
  [OpenSearchIndexName.EXPENSES]: new ElasticSearchExpensesAdapter(),
  [OpenSearchIndexName.HOST_APPLICATIONS]: new ElasticSearchHostApplicationsAdapter(),
  [OpenSearchIndexName.ORDERS]: new ElasticSearchOrdersAdapter(),
  [OpenSearchIndexName.TIERS]: new OpenSearchTiersAdapter(),
  [OpenSearchIndexName.TRANSACTIONS]: new OpenSearchTransactionsAdapter(),
  [OpenSearchIndexName.UPDATES]: new ElasticSearchUpdatesAdapter(),
} as const;

let AdaptersFromTableNames: Record<string, OpenSearchModelAdapter>;

export const getAdapterFromTableName = (table: string): OpenSearchModelAdapter | undefined => {
  if (!AdaptersFromTableNames) {
    AdaptersFromTableNames = Object.values(OpenSearchModelsAdapters).reduce(
      (acc, adapter) => {
        acc[adapter.getModel().tableName] = adapter;
        return acc;
      },
      {} as Record<string, OpenSearchModelAdapter>,
    );
  }

  return AdaptersFromTableNames[table];
};
