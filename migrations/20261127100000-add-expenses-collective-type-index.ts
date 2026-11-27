'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Index to tell whether an account has expenses of some types, part of opencollective/opencollective#8642. It serves
 * the `RECEIVE_EXPENSES` and `RECEIVE_GRANTS` feature-status probes (`HAS_RECEIVED_EXPENSES` and `HAS_RECEIVED_GRANTS`
 * in `server/graphql/loaders/feature-probes.ts`), which every profile and dashboard page runs.
 *
 * With `expenses_collective_id` alone, a probe that finds nothing reads every expense of the account from the table to
 * check its type. For an account with 4,445 expenses and no grant: about 4,000 pages, 1 ms when they are all in cache
 * and 78 ms when none is. With this index: 3 to 9 pages of the index and 0.02 ms.
 *
 * Partial on `"deletedAt" IS NULL`: the model is paranoid, and the probes only look at the expenses that are not deleted.
 *
 * Measured on 1M expenses (768 MB table): 0.5 s to build, 8.7 MB.
 *
 * Built with `CREATE INDEX CONCURRENTLY`: it holds a `SHARE UPDATE EXCLUSIVE` lock on "Expenses" (as `ANALYZE` does),
 * which blocks neither reads nor writes, only schema changes and `VACUUM` on that table. It waits for the transactions
 * that are open on the table when it starts. The helper then runs `ANALYZE "Expenses"`.
 */

const INDEXES = [
  {
    table: 'Expenses',
    name: 'expenses__collective_id_type',
    definition: `("CollectiveId", "type")`,
    where: `"deletedAt" IS NULL`,
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
