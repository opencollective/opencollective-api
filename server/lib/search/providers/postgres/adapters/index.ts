import { SearchEntity } from '../../../types';

import { AccountsAdapter } from './accounts';
import type { PostgresSearchAdapter } from './types';

/**
 * Entities supported by the PostgreSQL provider. Add one adapter file per entity.
 */
const PostgresSearchAdapters: Partial<Record<SearchEntity, PostgresSearchAdapter>> = {
  [SearchEntity.ACCOUNTS]: AccountsAdapter,
};

export const getPostgresSearchAdapter = (entity: SearchEntity): PostgresSearchAdapter | null =>
  PostgresSearchAdapters[entity] || null;
