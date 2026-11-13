'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Trigram index to find users by a part of their email (`email ILIKE '%term%'`), for `findCommunitySearchAccountIds`
 * in `server/lib/community-search.ts` (opencollective/opencollective#8947): the search of the People page of the host
 * dashboard. The existing indexes on `email` are btrees, which only serve a full email address.
 *
 * Measured on 600k users: the lookup goes from a sequential scan (70 ms) to 1 ms. The index takes 4 s to build and
 * 44 MB; the `ANALYZE "Users"` that follows takes 0.1 s.
 *
 * Built with `CREATE INDEX CONCURRENTLY`: it holds a `SHARE UPDATE EXCLUSIVE` lock on "Users" (as `ANALYZE` does),
 * which blocks neither reads nor writes, only schema changes and `VACUUM` on that table. It waits for the transactions
 * that are open on the table when it starts.
 */

const INDEXES = [
  {
    table: 'Users',
    name: 'users__email_trgm',
    definition: `USING GIN (email gin_trgm_ops)`,
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
