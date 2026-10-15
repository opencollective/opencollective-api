import type { Kysely, SelectQueryBuilder } from 'kysely';

import type OAuthScopes from '../../../../../constants/oauth-scopes';
import type { DatabaseWithViews } from '../../../../kysely';
import type { SearchEntity, SearchEntityParams } from '../../../types';
import type { ParsedSearchInput } from '../input';

/**
 * Who is searching, already resolved for one entity request.
 * - `forbidPrivate` (unauthenticated, or OAuth token without the entity scope): public rows/fields only.
 * - `isRoot`: skips row/field permission predicates, never the eligibility rules (private Accounts stay excluded).
 * - `adminIds`: accounts administered by the user (empty when `forbidPrivate`).
 * - `deniedOAuthScopes`: rows that require one of these scopes must be excluded, even for root.
 */
export type PostgresSearchAccess = {
  forbidPrivate: boolean;
  isRoot: boolean;
  adminIds: number[];
  /** OAuth scopes required by some rows that the request does not have (see `SearchEntityRequest`) */
  deniedOAuthScopes: OAuthScopes[];
};

export type PostgresSearchContext<E extends SearchEntity = SearchEntity> = {
  input: ParsedSearchInput;
  /** Supplied scopes intersect: an adapter must apply both when both are set */
  scope: { accountId: number | null; hostId: number | null };
  access: PostgresSearchAccess;
  params: SearchEntityParams[E];
};

type SearchArmRow = { id: number; score: number };

/**
 * One index-friendly branch of an entity search. Each arm returns `(id, score)` rows and applies eligibility, scope,
 * filters and permissions itself. Arms are combined with `UNION ALL` and deduplicated by ID (best score wins).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- arms can select from any table
export type SearchArm = SelectQueryBuilder<DatabaseWithViews, any, SearchArmRow>;

/**
 * Turns a search into SQL arms for one entity. See `pg-adapter-contract` in the PostgreSQL search notes.
 */
export interface PostgresSearchAdapter<E extends SearchEntity = SearchEntity> {
  entity: E;
  /**
   * Returns the arms that can match the input. Return an empty array when nothing can match (e.g. the user has no
   * access to any row): the result is then an empty page without querying the database.
   */
  buildArms(db: Kysely<DatabaseWithViews>, context: PostgresSearchContext<E>): SearchArm[];
}
