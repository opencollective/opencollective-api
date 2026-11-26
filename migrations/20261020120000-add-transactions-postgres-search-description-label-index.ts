'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * PostgreSQL search provider, Transactions: exact descriptions (opencollective#8941).
 *
 * The expression is copied from `TransactionExpressions.normalizedDescription` in
 * `server/lib/search/providers/postgres/expressions.ts` and must stay identical to it (same as
 * `orders_pg_search_description_label`).
 *
 * With capped totals, the exact description arm is read in `id DESC` order up to the page depth and counted up to the
 * cap. Without this index, a word that matches millions of descriptions but (almost) never the whole description
 * ("fee", "invoice") made PostgreSQL scan the whole table backwards for the page, then visit every word match for the
 * count: > 50 s on 13M rows, vs 0.1-0.8 s with it. Not partial, so that the planner has statistics on the expression.
 * Measured: 20 s to build and 174 MB on 13M rows.
 *
 * Built with `CREATE INDEX CONCURRENTLY` so that writes are not blocked. On a large table, consider running it out of
 * band before deploying (`IF NOT EXISTS` makes this migration a no-op then).
 */

const INDEXES = [
  {
    name: 'transactions_pg_search_description_label',
    definition: `USING BTREE (public.oc_search_normalize(description))`,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    await createIndexesConcurrently(
      queryInterface,
      INDEXES.map(index => ({ table: 'Transactions', ...index })),
    );
  },

  async down(queryInterface: QueryInterface) {
    await dropIndexesConcurrently(queryInterface, INDEXES);
  },
};
