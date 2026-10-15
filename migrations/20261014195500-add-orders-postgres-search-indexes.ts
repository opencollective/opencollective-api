'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Indexes for the PostgreSQL search provider, Orders/Contributions (opencollective#8940).
 *
 * Expressions and predicates are copied from `OrderExpressions` in
 * `server/lib/search/providers/postgres/expressions.ts` and must stay identical to them. PayPal subscription IDs use
 * the existing unique `subscriptions_paypal_subscription_id` and `orders__subscription_id` indexes; receiving Account
 * rules use `collectives_pg_search_excluded` and `collectives_pg_search_hosted`.
 *
 * These indexes are deliberately NOT partial: PostgreSQL only collects statistics for the expressions of non-partial
 * indexes. Without them, every text match gets the default selectivity and the planner drives account-scoped
 * searches with the text index (measured on 5M orders: 23 s for "financial contribution" in one account, vs 0.4 s with
 * statistics, where it uses `orders_collective_id`). Deleted orders are filtered by the queries.
 *
 * Built with `CREATE INDEX CONCURRENTLY` (one statement per query, serially) so that writes are not blocked. A failed
 * concurrent build leaves an INVALID index: `createIndexesConcurrently` drops it and builds it again on the next run.
 */

const INDEXES = [
  {
    name: 'orders_pg_search_description',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(description, '')))`,
  },
  {
    name: 'orders_pg_search_description_label',
    definition: `USING BTREE (public.oc_search_normalize(description))`,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    await createIndexesConcurrently(
      queryInterface,
      INDEXES.map(index => ({ table: 'Orders', ...index })),
    );
  },

  async down(queryInterface: QueryInterface) {
    await dropIndexesConcurrently(queryInterface, INDEXES);
  },
};
