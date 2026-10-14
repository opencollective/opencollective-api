'use strict';

import { QueryInterface } from 'sequelize';

/**
 * Indexes for the PostgreSQL search provider, Expenses and their items (opencollective#8939).
 *
 * Expressions and predicates are copied from `ExpenseExpressions` and `ExpenseItemExpressions` in
 * `server/lib/search/providers/postgres/expressions.ts` and must stay identical to them.
 *
 * Built with `CREATE INDEX CONCURRENTLY` (one statement per query, serially) so that writes are not blocked. A failed
 * concurrent build leaves an INVALID index that `IF NOT EXISTS` would skip: check
 * `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`, drop and re-run.
 */

const INDEXES = [
  {
    table: 'Expenses',
    name: 'expenses_pg_search_public',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(description, '') || ' ' || coalesce(currency, '') || ' ' || coalesce(status, '') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", ''))))`,
    where: `"deletedAt" IS NULL`,
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
    where: `"deletedAt" IS NULL`,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    for (const index of INDEXES) {
      await queryInterface.sequelize.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ON "${index.table}" ${index.definition} WHERE ${index.where}`,
      );
    }

    await queryInterface.sequelize.query(`ANALYZE "Expenses"`);
    await queryInterface.sequelize.query(`ANALYZE "ExpenseItems"`);
  },

  async down(queryInterface: QueryInterface) {
    for (const index of INDEXES) {
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    }
  },
};
