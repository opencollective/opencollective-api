'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Indexes for the PostgreSQL search provider, Updates (opencollective#8938).
 *
 * Expressions and predicates are copied from `UpdateExpressions` and `HiddenAccountExpressions` in
 * `server/lib/search/providers/postgres/expressions.ts` and must stay identical to them.
 *
 * Built with `CREATE INDEX CONCURRENTLY` (one statement per query, serially) so that writes are not blocked. A failed
 * concurrent build leaves an INVALID index: `createIndexesConcurrently` drops it and builds it again on the next run.
 */

const ELIGIBLE = `"deletedAt" IS NULL`;

const INDEXES: Array<{ table: string; name: string; definition: string; where: string | null }> = [
  {
    // Accounts hidden from search, whose Updates are excluded with an index-only anti-join
    // (`HiddenAccountExpressions` / `isOwnedByAccountShownInSearch`)
    table: 'Collectives',
    name: 'collectives_pg_search_hidden',
    definition: `USING BTREE (id)`,
    where: `(data ->> 'hideFromSearch')::boolean IS TRUE`,
  },
  {
    // Not partial on purpose: PostgreSQL only uses the statistics of non-partial expression indexes. With them, the
    // planner knows how many Updates a word matches and switches from per-row lookups to hash anti-joins on broad
    // words (measured 2.2 s -> 0.6 s on 74k matches). Deleted Updates are a small fraction of the table.
    table: 'Updates',
    name: 'updates_pg_search_text',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(title, '') || ' ' || replace(coalesce(slug, ''), '-', ' ') || ' ' || public.oc_search_html_to_text(coalesce(html, ''))))`,
    where: null,
  },
  {
    table: 'Updates',
    name: 'updates_pg_search_title',
    definition: `USING BTREE (public.oc_search_normalize(title))`,
    where: ELIGIBLE,
  },
  {
    // The only existing slug index is `("CollectiveId", slug)`, which can't serve an unscoped slug lookup
    table: 'Updates',
    name: 'updates_pg_search_slug',
    definition: `USING BTREE (slug)`,
    where: ELIGIBLE,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    await createIndexesConcurrently(queryInterface, INDEXES);
  },

  async down(queryInterface: QueryInterface) {
    await dropIndexesConcurrently(queryInterface, INDEXES);
  },
};
