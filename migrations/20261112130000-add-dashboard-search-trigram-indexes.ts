'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Trigram indexes for `buildSearchArms` in `server/lib/sql-search.ts` (opencollective/opencollective#8947): the
 * `searchTerm` of contributions and transactions in the dashboard.
 *
 * - Accounts by partial name or slug (`name ILIKE '%term%' OR slug ILIKE '%term%'`), on every account that is not
 *   deleted: guests, incognito profiles and private accounts included. The existing trigram index
 *   (`collectives_pg_search_name_trgm`) can't be used for that: it is on the unaccented name and restricted to the
 *   accounts of the public search. Measured on 649k accounts: the lookup goes from a sequential scan (130 ms) to
 *   0.3 ms. About 1 s each to build, 25 MB (name) and 17 MB (slug).
 * - Transactions by partial description. Without it, the description arm of a search reads every transaction of its
 *   scope: 2 s for a host with 11.5M transactions, instead of 30 ms. Measured on 18.5M transactions: 97 s to build,
 *   617 MB. Contributions already have `Orders_description_search_idx`.
 *
 * Built with `CREATE INDEX CONCURRENTLY` so that writes are not blocked. On a large table, consider running them out
 * of band before deploying (`IF NOT EXISTS` makes this migration a no-op then).
 */

const INDEXES = [
  {
    table: 'Collectives',
    name: 'collectives__name_trgm',
    definition: `USING GIN (name gin_trgm_ops)`,
    where: `"deletedAt" IS NULL`,
  },
  {
    table: 'Collectives',
    name: 'collectives__slug_trgm',
    definition: `USING GIN (slug gin_trgm_ops)`,
    where: `"deletedAt" IS NULL`,
  },
  {
    table: 'Transactions',
    name: 'transactions__description_trgm',
    definition: `USING GIN (description gin_trgm_ops)`,
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
