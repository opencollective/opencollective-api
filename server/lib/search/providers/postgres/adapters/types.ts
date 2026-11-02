import type { Kysely, SelectQueryBuilder } from 'kysely';

import type OAuthScopes from '../../../../../constants/oauth-scopes';
import type { DatabaseWithViews } from '../../../../kysely';
import type { SearchEntity, SearchEntityParams, SearchHit } from '../../../types';
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
 * Turns a search into SQL arms for one entity. See "Adapter contract" in `docs/postgres-search.md`.
 */
export interface PostgresSearchAdapter<E extends SearchEntity = SearchEntity> {
  entity: E;
  /**
   * Returns the arms that can match the input. Return an empty array when nothing can match (e.g. the user has no
   * access to any row): the result is then an empty page without querying the database.
   */
  buildArms(db: Kysely<DatabaseWithViews>, context: PostgresSearchContext<E>): SearchArm[];
  /**
   * Optional: how many matches a search of this entity can count per second (measured). When set, searches whose
   * estimated matches exceed what fits in the remaining budget fail before running (see `estimates.ts`).
   */
  estimatedMatchesPerSecond?: number;
  /**
   * Optional: every arm has a constant score (no lexical bonus, no CASE). Pages then stop early and totals are capped
   * (`search.postgres.maxCountedMatches`) instead of counting every match (see `query-builder.ts`).
   */
  constantScorePerArm?: boolean;
  /** Optional: adds entity-specific details to the hits of the page (e.g. the UUID of Transactions) */
  decorateHits?(db: Kysely<DatabaseWithViews>, hits: SearchHit[]): Promise<SearchHit[]>;
}
