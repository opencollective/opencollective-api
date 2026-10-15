'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * PostgreSQL search provider, Transactions (opencollective#8941).
 *
 * Expressions are copied from `TransactionExpressions` in `server/lib/search/providers/postgres/expressions.ts` and
 * must stay identical to them.
 *
 * - `oc_search_transaction_merchant_id(kind, data)` reproduces the model's virtual `merchantId` getter
 *   (`MERCHANT_ID_PATHS` in `server/models/Transaction.ts`): the first non-empty provider ID of the row's JSON for its
 *   kind. If those paths change, update this function in a new migration and REINDEX `transactions_pg_search_merchant_id`.
 * - Description words are indexed together with the host and with the account (`btree_gin`), so that scoped searches
 *   only visit the matches of their scope: a broad word on a large host went from 4 s to 0.4 s on 5M rows. Either index
 *   also serves unscoped searches.
 * - Indexes are NOT partial: PostgreSQL only collects statistics for the expressions of non-partial indexes. The
 *   planner needs them to drive scoped searches on common words with the scope's index, and to know that a merchant
 *   ID matches a handful of rows (without them, it combined the merchant ID index with `transactions_kind` and
 *   scanned every platform tip: 5 s instead of 1 ms on 5M rows). NULL merchant IDs are deduplicated by the btree.
 *
 * Built with `CREATE INDEX CONCURRENTLY` (one statement per query, serially) so that writes are not blocked. On a large
 * table, consider running them out of band before deploying (`IF NOT EXISTS` makes this migration a no-op then). A
 * failed concurrent build leaves an INVALID index: `createIndexesConcurrently` drops it and builds it again on the next run.
 */

const DESCRIPTION_VECTOR = `to_tsvector('public.oc_search_english'::regconfig, coalesce(description, ''))`;

const INDEXES = [
  {
    name: 'transactions_pg_search_host_description',
    definition: `USING GIN ("HostCollectiveId", ${DESCRIPTION_VECTOR})`,
  },
  {
    name: 'transactions_pg_search_collective_description',
    definition: `USING GIN ("CollectiveId", ${DESCRIPTION_VECTOR})`,
  },
  {
    name: 'transactions_pg_search_merchant_id',
    definition: `USING BTREE (public.oc_search_transaction_merchant_id(kind, data))`,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    // Integer columns in GIN indexes. Like `unaccent`, it may be installed in a dedicated schema (e.g. `heroku_ext`) on
    // some hosting providers: the default operator classes are found regardless of the schema.
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS btree_gin`);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION public.oc_search_transaction_merchant_id(kind public."enum_Transactions_kind", data jsonb)
      RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $$
        SELECT CASE kind
          WHEN 'CONTRIBUTION' THEN coalesce(
            nullif(data #>> '{charge,id}', ''),
            nullif(data #>> '{paypalRefundId}', ''),
            nullif(data #>> '{paypalCaptureId}', ''),
            nullif(data #>> '{capture,id}', ''),
            nullif(data #>> '{refund,id}', ''),
            nullif(data #>> '{paypalSale,id}', ''),
            nullif(data #>> '{paypalResponse,id}', '')
          )
          WHEN 'EXPENSE' THEN coalesce(
            nullif(data #>> '{transfer,id}', ''),
            nullif(data #>> '{transaction_id}', ''),
            nullif(data #>> '{token}', ''),
            nullif(data #>> '{transaction,id}', '')
          )
        END
      $$
    `);

    await createIndexesConcurrently(
      queryInterface,
      INDEXES.map(index => ({ table: 'Transactions', ...index })),
    );
  },

  async down(queryInterface: QueryInterface) {
    await dropIndexesConcurrently(queryInterface, INDEXES);

    await queryInterface.sequelize.query(
      `DROP FUNCTION IF EXISTS public.oc_search_transaction_merchant_id(public."enum_Transactions_kind", jsonb)`,
    );
    // The `btree_gin` extension is left installed: it may be used elsewhere
  },
};
