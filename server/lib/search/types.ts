/**
 * Provider-independent search contract. The GraphQL layer builds a `SearchRequest` (one per `search` field) and
 * one `SearchEntityRequest` per requested entity field; a `SearchProviderImplementation` turns them into
 * `SearchEntityResult`s. Nothing in here is specific to a search backend.
 */

import { CollectiveType } from '../../constants/collectives';
import type { Collective, User } from '../../models';

/**
 * Search backends, exposed in GraphQL as `SearchBackend`.
 */
export enum SearchProvider {
  OPENSEARCH = 'OPENSEARCH',
  POSTGRES = 'POSTGRES',
}

/**
 * Searchable entities, named after their field in `SearchResults`.
 */
export enum SearchEntity {
  ACCOUNTS = 'accounts',
  COMMENTS = 'comments',
  EXPENSES = 'expenses',
  HOST_APPLICATIONS = 'hostApplications',
  ORDERS = 'orders',
  TIERS = 'tiers',
  TRANSACTIONS = 'transactions',
  UPDATES = 'updates',
}

/**
 * Entity-specific filters, already converted from GraphQL to model values.
 */
export interface SearchEntityParams extends Record<SearchEntity, Record<string, unknown>> {
  [SearchEntity.ACCOUNTS]: {
    type?: CollectiveType;
    isHost?: boolean;
    tags?: string[];
  };
}

type SearchScope = {
  /** Restrict results to this account (and its children) */
  account: Collective | null;
  /** Restrict results to this host (and its hosted accounts) */
  host: Collective | null;
};

/**
 * Everything that is shared by all the entities requested through a single `search` field.
 */
export type SearchRequest = {
  provider: SearchProvider;
  term: string;
  scope: SearchScope;
  /** Access context: the user on whose behalf the search runs (`null` when unauthenticated) */
  remoteUser: User | null;
  /** Maximum time to wait for a single entity search. Providers that have their own budget may ignore it. */
  timeoutInMs: number;
  /** Rank all entities together (no pagination with offset) */
  useTopHits: boolean;
};

/**
 * One requested entity field (e.g. `accounts(limit: 5, type: ORGANIZATION)`). Each one is searched with its own
 * filters, access and pagination: aliases and pages never share these values.
 */
export type SearchEntityRequest<E extends SearchEntity = SearchEntity> = {
  entity: E;
  params: SearchEntityParams[E];
  /** Access context: exclude private rows and fields (unauthenticated, or OAuth token without the entity scope) */
  forbidPrivate: boolean;
  limit: number;
  offset: number;
};

export type SearchHit = {
  /** Database ID of the entity */
  id: number;
  /** Only set for entities that are identified by UUID in GraphQL (transactions) */
  uuid?: string;
  score: number;
  highlight?: Record<string, string[]>;
};

export type SearchEntityResult = {
  totalCount: number;
  maxScore: number;
  hits: SearchHit[];
};

export interface SearchProviderImplementation {
  /** Throws if the provider cannot serve requests (e.g. not configured) */
  assertAvailable(): void;
  /** Throws if the request is not supported by this provider (e.g. input too long). Called before any search. */
  validateRequest?(request: SearchRequest): void;
  /**
   * Searches all the entity requests that share the same `SearchRequest`. Must resolve with one result per
   * entity request, in the same order (`null` when the entity can't be searched with this access context, an
   * `Error` when this entity request failed: it is reported on its own GraphQL field).
   */
  search(
    request: SearchRequest,
    entityRequests: SearchEntityRequest[],
  ): Promise<Array<SearchEntityResult | null | Error>>;
}
