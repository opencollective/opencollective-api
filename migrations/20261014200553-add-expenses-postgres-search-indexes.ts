'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Indexes for the PostgreSQL search provider, Expenses and their items (opencollective#8939).
 *
 * Expressions and predicates are copied from `ExpenseExpressions` and `ExpenseItemExpressions` in
 * `server/lib/search/providers/postgres/expressions.ts` and must stay identical to them.
 *
 * Text indexes are NOT partial (queries filter deleted rows themselves): PostgreSQL only collects statistics for the
 * expressions of non-partial indexes, and the planner needs word frequencies to choose between the text index and
 * the scope indexes (measured in opencollective#8944, see `docs/postgres-search.md`).
 *
 * Built with `CREATE INDEX CONCURRENTLY` (one statement per query, serially) so that writes are not blocked. A failed
 * concurrent build leaves an INVALID index: `createIndexesConcurrently` drops it and builds it again on the next run.
 */

const INDEXES = [
  {
    table: 'Expenses',
    name: 'expenses_pg_search_public',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(description, '') || ' ' || coalesce(currency, '') || ' ' || coalesce(status, '') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", ''))))`,
  },
  {
    table: 'Expenses',
    name: 'expenses_pg_search_restricted',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(description, '') || ' ' || coalesce(currency, '') || ' ' || coalesce(status, '') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", '')) || ' ' || public.oc_search_html_to_text(coalesce("privateMessage", '')) || ' ' || coalesce("invoiceInfo", '') || ' ' || coalesce(reference, '')))`,
    where: `"deletedAt" IS NULL AND ("privateMessage" IS NOT NULL OR "invoiceInfo" IS NOT NULL OR reference IS NOT NULL)`,
  },
  {
    table: 'Expenses',
    name: 'expenses_pg_search_description',
    definition: `USING BTREE (public.oc_search_normalize(description))`,
    where: `"deletedAt" IS NULL`,
  },
  {
    // Item matches only need these columns of their Expense: index-only lookups, never the wide heap
    table: 'Expenses',
    name: 'expenses_pg_search_accounts',
    definition: `USING BTREE (id) INCLUDE ("CollectiveId", "FromCollectiveId", "HostCollectiveId")`,
    where: `"deletedAt" IS NULL`,
  },
  {
    table: 'ExpenseItems',
    name: 'expense_items_pg_search',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, public.oc_search_html_to_text(coalesce(description, ''))))`,
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
