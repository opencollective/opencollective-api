import { SearchEntity } from '../../../types';

import { AccountsAdapter } from './accounts';
import { HostApplicationsAdapter } from './host-applications';
import { OrdersAdapter } from './orders';
import { TiersAdapter } from './tiers';
import type { PostgresSearchAdapter } from './types';

/**
 * Entities supported by the PostgreSQL provider. Add one adapter file per entity.
 */
const PostgresSearchAdapters: Partial<Record<SearchEntity, PostgresSearchAdapter>> = {
  [SearchEntity.ACCOUNTS]: AccountsAdapter,
  [SearchEntity.TIERS]: TiersAdapter,
  [SearchEntity.HOST_APPLICATIONS]: HostApplicationsAdapter,
  [SearchEntity.ORDERS]: OrdersAdapter,
};

export const getPostgresSearchAdapter = (entity: SearchEntity): PostgresSearchAdapter | null =>
  PostgresSearchAdapters[entity] || null;
