/**
 * SQL expressions shared by PostgreSQL search queries and the indexes that serve them.
 *
 * The planner only uses an expression/partial index when the query repeats the indexed expression and predicate
 * exactly (same functions, casts, `coalesce`, configuration and argument order). Migrations can't import app code,
 * so they copy these literals: when changing one, write a migration that rebuilds the matching index, and verify
 * the plan with `EXPLAIN`.
 *
 * Normalization primitives (see `migrations/20261014120000-add-postgres-search-normalization.ts`):
 * - `public.oc_search_unaccent(text)`: immutable accent folding
 * - `public.oc_search_normalize(text)`: accent folding + lowercase + collapsed whitespace, for exact labels
 * - `public.oc_search_html_to_text(text)`: bounded HTML-to-text for HTML bodies
 * - `public.oc_search_english`: accent-folding, stemming text search configuration (prose, ordinary words)
 * - `public.oc_search_simple`: accent-folding text search configuration without stemming (labels, prefixes)
 */

import { RawBuilder, sql } from 'kysely';

const SEARCH_CONFIG_ENGLISH = `'public.oc_search_english'::regconfig`;
const SEARCH_CONFIG_SIMPLE = `'public.oc_search_simple'::regconfig`;

/** Ordinary words: every word of the input is required (AND), with stemming and accent folding */
export const wordsTsQuery = (term: string): RawBuilder<unknown> =>
  sql`plainto_tsquery(${sql.raw(SEARCH_CONFIG_ENGLISH)}, ${term})`;

/** Word prefixes, built from sanitized tokens only (see `input.ts`) */
export const prefixTsQuery = (prefixQuery: string): RawBuilder<unknown> =>
  sql`to_tsquery(${sql.raw(SEARCH_CONFIG_SIMPLE)}, ${prefixQuery})`;

/** Exact label comparison: apply the same normalization to the input as to the indexed column */
export const normalizedValue = (term: string): RawBuilder<string> => sql`public.oc_search_normalize(${term})`;

/** Typo matching: pg_trgm already lowercases and splits words, only accents need folding */
export const unaccentedValue = (term: string): RawBuilder<string> => sql`public.oc_search_unaccent(${term})`;

/**
 * Accounts (`Collectives`). Column references are unqualified so that the same text can be used in index
 * definitions; queries must select from "Collectives" without another table exposing these column names.
 */
export const AccountExpressions = {
  /** Rows that can be searched by anyone, including root (matches the OpenSearch indexing rules) */
  eligible: `"deletedAt" IS NULL AND "isPrivate" = false AND "isIncognito" = false AND "deactivatedAt" IS NULL AND (data ->> 'hideFromSearch')::boolean IS NOT TRUE AND (data ->> 'isGuest')::boolean IS NOT TRUE AND name <> 'incognito' AND name <> 'anonymous'`,
  /** Public searchable fields (index `collectives_pg_search_public`) */
  publicVector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(name, '') || ' ' || replace(coalesce(slug, ''), '-', ' ') || ' ' || coalesce(description, '') || ' ' || coalesce(website, '') || ' ' || public.array_to_string_immutable(coalesce(tags, '{}')::text[], ' ') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", '')))`,
  /** Public + restricted fields (index `collectives_pg_search_restricted`, only rows with a legal name) */
  restrictedVector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(name, '') || ' ' || replace(coalesce(slug, ''), '-', ' ') || ' ' || coalesce(description, '') || ' ' || coalesce(website, '') || ' ' || public.array_to_string_immutable(coalesce(tags, '{}')::text[], ' ') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", '')) || ' ' || coalesce("legalName", ''))`,
  restrictedPredicate: `"legalName" IS NOT NULL`,
  /** Name and slug words, without stemming, for prefixes (index `collectives_pg_search_label`) */
  labelVector: `to_tsvector('public.oc_search_simple'::regconfig, coalesce(name, '') || ' ' || replace(coalesce(slug, ''), '-', ' '))`,
  /** Exact name (index `collectives_pg_search_name`) */
  normalizedName: `public.oc_search_normalize(name)`,
  /** Name typos (trigram index `collectives_pg_search_name_trgm`) */
  unaccentedName: `public.oc_search_unaccent(name)`,
} as const;

/**
 * Expenses. Column references are unqualified (see `AccountExpressions`): queries use them on "Expenses" without
 * another table exposing these column names. `currency` and `status` are plain strings (not enums), so they can be
 * part of the vectors.
 */
export const ExpenseExpressions = {
  /** Rows that can be searched (the owning account's eligibility is checked separately) */
  eligible: `"deletedAt" IS NULL`,
  /** Public searchable fields (index `expenses_pg_search_public`, not partial so that the planner has statistics) */
  publicVector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(description, '') || ' ' || coalesce(currency, '') || ' ' || coalesce(status, '') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", '')))`,
  /** Public + restricted fields (index `expenses_pg_search_restricted`, only rows with restricted information) */
  restrictedVector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(description, '') || ' ' || coalesce(currency, '') || ' ' || coalesce(status, '') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", '')) || ' ' || public.oc_search_html_to_text(coalesce("privateMessage", '')) || ' ' || coalesce("invoiceInfo", '') || ' ' || coalesce(reference, ''))`,
  restrictedPredicate: `("privateMessage" IS NOT NULL OR "invoiceInfo" IS NOT NULL OR reference IS NOT NULL)`,
  /** Exact description (index `expenses_pg_search_description`) */
  normalizedDescription: `public.oc_search_normalize(description)`,
} as const;

/** Expense items, searched as part of their Expense. Descriptions may contain HTML. */
export const ExpenseItemExpressions = {
  eligible: `"deletedAt" IS NULL`,
  /** Index `expense_items_pg_search` (not partial, for statistics) */
  vector: `to_tsvector('public.oc_search_english'::regconfig, public.oc_search_html_to_text(coalesce(description, '')))`,
} as const;

/**
 * Accounts that make their dependent rows (tiers, applications...) unsearchable for everyone: deleted or private.
 * Index `collectives_pg_search_excluded` (on `id`) covers exactly these rows, so that dependent entities can exclude
 * them with an anti-join (`NOT EXISTS`) that never reads the wide "Collectives" heap. It is much cheaper than looking up
 * the owning Account of every candidate on broad terms (measured: 77 s vs 3 s cold for 55k candidates).
 */
const ExcludedAccountExpressions = {
  excluded: `"deletedAt" IS NOT NULL OR "isPrivate" = true`,
} as const;

/** The account referenced by `accountIdColumn` (e.g. `Tiers.CollectiveId`) is neither deleted nor private */
export const isOwnedByEligibleAccount = (accountIdColumn: string): RawBuilder<boolean> =>
  sql<boolean>`NOT EXISTS (SELECT 1 FROM "Collectives" excluded_account WHERE excluded_account.id = ${sql.ref(accountIdColumn)} AND (${sql.raw(ExcludedAccountExpressions.excluded)}))`;

/**
 * The given account is neither deleted nor private, as a one-time check. Use it instead of `isOwnedByEligibleAccount`
 * when a scope fixes the account: an anti-join against a constant makes the planner estimate a single matching row.
 */
export const isEligibleAccountId = (accountId: number): RawBuilder<boolean> =>
  sql<boolean>`NOT EXISTS (SELECT 1 FROM "Collectives" excluded_account WHERE excluded_account.id = ${accountId} AND (${sql.raw(ExcludedAccountExpressions.excluded)}))`;

/**
 * Tiers. Same conventions as `AccountExpressions` (unqualified columns of "Tiers").
 */
export const TierExpressions = {
  /** Live tiers (owning Account rules: `isOwnedByEligibleAccount`) */
  eligible: `"deletedAt" IS NULL`,
  /** Searchable fields: name, slug, description and long description (index `tiers_pg_search_vector`, not partial) */
  vector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(name, '') || ' ' || replace(coalesce(slug, ''), '-', ' ') || ' ' || coalesce(description, '') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", '')))`,
  /** Exact name (index `tiers_pg_search_name`) */
  normalizedName: `public.oc_search_normalize(name)`,
} as const;

/**
 * Host applications. Same conventions as `AccountExpressions` (unqualified columns of "HostApplications").
 */
export const HostApplicationExpressions = {
  /** Live applications (owning Account rules: `isOwnedByEligibleAccount`) */
  eligible: `"deletedAt" IS NULL`,
  /** Searchable fields: message (index `host_applications_pg_search_message`, not partial) */
  vector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(message, ''))`,
} as const;

/**
 * Orders/Contributions. Same conventions as `AccountExpressions` (unqualified columns of "Orders").
 */
export const OrderExpressions = {
  /** Live contributions (receiving Account rules: `isOwnedByEligibleAccount`) */
  eligible: `"deletedAt" IS NULL`,
  /** Description words (index `orders_pg_search_description`, not partial so that the planner has statistics) */
  descriptionVector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(description, ''))`,
  /** Exact description (index `orders_pg_search_description_label`, not partial) */
  normalizedDescription: `public.oc_search_normalize(description)`,
} as const;

/**
 * Accounts hidden from search (`data.hideFromSearch`): their Updates are not searchable, even for root. Index
 * `collectives_pg_search_hidden` (on `id`) covers exactly these rows, for an index-only anti-join (see
 * `isOwnedByEligibleAccount`).
 */
const HiddenAccountExpressions = {
  hidden: `(data ->> 'hideFromSearch')::boolean IS TRUE`,
} as const;

/** The account referenced by `accountIdColumn` is not hidden from search */
export const isOwnedByAccountShownInSearch = (accountIdColumn: string): RawBuilder<boolean> =>
  sql<boolean>`NOT EXISTS (SELECT 1 FROM "Collectives" hidden_account WHERE hidden_account.id = ${sql.ref(accountIdColumn)} AND ${sql.raw(HiddenAccountExpressions.hidden)})`;

/**
 * Updates. Same conventions as `AccountExpressions` (unqualified columns of "Updates").
 */
export const UpdateExpressions = {
  /** Live Updates (owning Account rules: `isOwnedByEligibleAccount` + `isOwnedByAccountShownInSearch`) */
  eligible: `"deletedAt" IS NULL`,
  /** Updates that everyone who can see the Account can see */
  publiclyVisible: `("isPrivate" = false AND "publishedAt" IS NOT NULL)`,
  /** Title, slug words and HTML-stripped body (index `updates_pg_search_text`, not partial: see its migration) */
  vector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(title, '') || ' ' || replace(coalesce(slug, ''), '-', ' ') || ' ' || public.oc_search_html_to_text(coalesce(html, '')))`,
  /** Exact title (index `updates_pg_search_title`) */
  normalizedTitle: `public.oc_search_normalize(title)`,
} as const;

/**
 * Comments. Same conventions as `AccountExpressions` (unqualified columns of "Comments").
 */
export const CommentExpressions = {
  /** Live Comments (owning Account and parent rules are checked separately) */
  eligible: `"deletedAt" IS NULL`,
  /** HTML body as plain text (index `comments_pg_search_text`, not partial so that the planner has statistics) */
  vector: `to_tsvector('public.oc_search_english'::regconfig, public.oc_search_html_to_text(coalesce(html, '')))`,
} as const;

/**
 * Transactions. Same conventions as `AccountExpressions` (unqualified columns of "Transactions").
 */
export const TransactionExpressions = {
  /** Live transactions (Account rules: `isOwnedByEligibleAccount` on CollectiveId, FromCollectiveId and HostCollectiveId) */
  eligible: `"deletedAt" IS NULL`,
  /**
   * Description words, indexed with `HostCollectiveId` and with `CollectiveId` (indexes
   * `transactions_pg_search_host_description` / `transactions_pg_search_collective_description`, `btree_gin`, not
   * partial so that the planner has statistics)
   */
  descriptionVector: `to_tsvector('public.oc_search_english'::regconfig, coalesce(description, ''))`,
  /** Exact description, only computed on rows that match the words (no index) */
  normalizedDescription: `public.oc_search_normalize(description)`,
  /**
   * The model's virtual `merchantId` from the row's own JSON (`MERCHANT_ID_PATHS` in `server/models/Transaction.ts`:
   * first non-empty path for the kind). Index `transactions_pg_search_merchant_id`.
   */
  merchantId: `public.oc_search_transaction_merchant_id(kind, data)`,
} as const;
