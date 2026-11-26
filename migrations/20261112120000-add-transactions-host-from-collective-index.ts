'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Transactions of one account on the other side of a host's ledger (opencollective/opencollective#8947).
 *
 * `transactions(host: X, fromAccount: Y)` filters on `"HostCollectiveId" = X AND "FromCollectiveId" = Y` and reads the
 * most recent rows first. No index started with `FromCollectiveId`, apart from
 * `transactions__contributions_fromcollective_to_host` which only covers non-refunded contributions. PostgreSQL
 * therefore walked the host's transactions by date (`transactions__host_collective_id_created_at_regular`) and
 * filtered on `FromCollectiveId`: when the account has few or no matching rows, the `LIMIT` is never reached and the
 * host's whole ledger is read. This is what the "recent credits / debits" lists of the host dashboard's People page do.
 *
 * Measured on a host with 11.5M transactions (18.5M rows in the table): 1.7 s to 4.8 s per query before, 0.1 ms to
 * 80 ms after. The index takes 11 s to build and 519 MB. `createdAt` has to be part of the index: without it, the planner kept the walk by date.
 *
 * Built with `CREATE INDEX CONCURRENTLY` so that writes are not blocked. On a large table, consider running it out of
 * band before deploying (`IF NOT EXISTS` makes this migration a no-op then).
 */

const INDEXES = [
  {
    name: 'transactions__host_collective_id_from_collective_id_created_at',
    definition: `USING BTREE ("HostCollectiveId", "FromCollectiveId", "createdAt" DESC)`,
    where: `"deletedAt" IS NULL`,
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
