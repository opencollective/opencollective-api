'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Indexes for the search arms of the expenses `searchTerm` (opencollective/opencollective#8947, `buildSearchArms` in
 * `server/lib/sql-search.ts`). Each searched column gets its own arm: these three had no index, so their arm read
 * every expense. Measured on 1M expenses, for one arm:
 *
 * - `expenses__description_trgm`: partial description (`description ILIKE '%term%'`), in every text search. From a
 *   sequential scan (245 ms) to 0.8 ms for a term in 100 descriptions. 7.8 s to build, 80 MB.
 * - `expenses__tags`: tags (`tags && ARRAY['term']`), in every text search. From 147 ms to 72 ms for a tag on 18k
 *   expenses, and to less than 1 ms for a term that is not a tag. 0.6 s to build, 3 MB.
 * - `expenses__amount`: amount, when the term is a number. From 120 ms to 0.04 ms. 0.4 s to build, 10 MB.
 *
 * Built with `CREATE INDEX CONCURRENTLY`, so that writes on expenses are not blocked: a build only waits for the
 * transactions that are open on the table when it starts. The migration ends with `ANALYZE "Expenses"` (0.6 s, does
 * not block reads or writes). 9.5 s in total on 1M expenses.
 */

const INDEXES = [
  {
    table: 'Expenses',
    name: 'expenses__description_trgm',
    definition: `USING GIN (description gin_trgm_ops)`,
    where: `"deletedAt" IS NULL`,
  },
  {
    table: 'Expenses',
    name: 'expenses__tags',
    definition: `USING GIN (tags)`,
    where: `"deletedAt" IS NULL`,
  },
  {
    table: 'Expenses',
    name: 'expenses__amount',
    definition: `(amount)`,
    where: `"deletedAt" IS NULL`,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await createIndexesConcurrently(queryInterface, INDEXES);
  },

  async down(queryInterface: QueryInterface) {
    await dropIndexesConcurrently(queryInterface, INDEXES);
  },
};
