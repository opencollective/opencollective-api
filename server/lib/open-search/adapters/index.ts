import { OpenSearchIndexName } from '../constants';

import { OpenSearchCollectivesAdapter } from './OpenSearchCollectivesAdapter';
import { OpenSearchCommentsAdapter } from './OpenSearchCommentsAdapter';
import { OpenSearchExpensesAdapter } from './OpenSearchExpensesAdapter';
import { OpenSearchHostApplicationsAdapter } from './OpenSearchHostApplicationsAdapter';
import { OpenSearchModelAdapter } from './OpenSearchModelAdapter';
import { OpenSearchOrdersAdapter } from './OpenSearchOrdersAdapter';
import { OpenSearchTiersAdapter } from './OpenSearchTiersAdapter';
import { OpenSearchTransactionsAdapter } from './OpenSearchTransactionsAdapter';
import { OpenSearchUpdatesAdapter } from './OpenSearchUpdatesAdapter';

export const OpenSearchModelsAdapters: Record<OpenSearchIndexName, OpenSearchModelAdapter> = {
  [OpenSearchIndexName.COLLECTIVES]: new OpenSearchCollectivesAdapter(),
  [OpenSearchIndexName.COMMENTS]: new OpenSearchCommentsAdapter(),
  [OpenSearchIndexName.EXPENSES]: new OpenSearchExpensesAdapter(),
  [OpenSearchIndexName.HOST_APPLICATIONS]: new OpenSearchHostApplicationsAdapter(),
  [OpenSearchIndexName.ORDERS]: new OpenSearchOrdersAdapter(),
  [OpenSearchIndexName.TIERS]: new OpenSearchTiersAdapter(),
  [OpenSearchIndexName.TRANSACTIONS]: new OpenSearchTransactionsAdapter(),
  [OpenSearchIndexName.UPDATES]: new OpenSearchUpdatesAdapter(),
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
