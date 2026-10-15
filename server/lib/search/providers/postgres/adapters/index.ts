import { SearchEntity } from '../../../types';

import { AccountsAdapter } from './accounts';
import { CommentsAdapter } from './comments';
import { ExpensesAdapter } from './expenses';
import { HostApplicationsAdapter } from './host-applications';
import { OrdersAdapter } from './orders';
import { TiersAdapter } from './tiers';
import type { PostgresSearchAdapter } from './types';
import { UpdatesAdapter } from './updates';

/**
 * Entities supported by the PostgreSQL provider. Add one adapter file per entity.
 */
const PostgresSearchAdapters: Partial<Record<SearchEntity, PostgresSearchAdapter>> = {
  [SearchEntity.ACCOUNTS]: AccountsAdapter,
  [SearchEntity.COMMENTS]: CommentsAdapter,
  [SearchEntity.EXPENSES]: ExpensesAdapter,
  [SearchEntity.TIERS]: TiersAdapter,
  [SearchEntity.HOST_APPLICATIONS]: HostApplicationsAdapter,
  [SearchEntity.ORDERS]: OrdersAdapter,
  [SearchEntity.UPDATES]: UpdatesAdapter,
};

export const getPostgresSearchAdapter = (entity: SearchEntity): PostgresSearchAdapter | null =>
  PostgresSearchAdapters[entity] || null;
