'use strict';

import { QueryInterface } from 'sequelize';

/**
 * Planner statistics on the host of an account together with whether it is approved
 * (opencollective/opencollective#8947).
 *
 * Host dashboard incoming contributions are usually filtered with `"HostCollectiveId" = <host> AND "approvedAt" IS NOT
 * NULL`. PostgreSQL estimates the two conditions separately and multiplies them, but they are strongly correlated:
 * nearly all accounts are individuals, with neither a host nor an approval date. On 649k accounts, a host with 5,505
 * approved accounts was estimated at 63, and its 1.47M contributions at 250. The planner then read all of them to
 * sort them, where reading the most recent contributions first finds a page immediately: 4.3 s instead of 1 ms for the
 * first page of the host's incoming contributions, 4.0 s instead of 1.1 s for their total.
 *
 * The statistics are on an expression rather than on `"approvedAt"`: with one distinct date per account, the most
 * common (host, date) pairs say nothing about a host. Each host of some size has its own (host, true) entry instead.
 *
 * The expression has to be `("approvedAt" IS NOT NULL) IS TRUE`, not just `"approvedAt" IS NOT NULL`. PostgreSQL
 * reads a bare `IS NOT NULL` condition as a condition on the column, and looks for statistics on `"approvedAt"`
 * itself: it never matches it with an expression. `IS TRUE` makes the condition an opaque boolean expression, which
 * is matched with statistics on the same expression. Estimates for this host (5,505 accounts), per statistics and
 * per condition in the query:
 *
 *   statistics on ("approvedAt" IS NOT NULL)            "approvedAt" IS NOT NULL             ->    60
 *                                                       ("approvedAt" IS NOT NULL) IS TRUE   ->    60
 *   statistics on (("approvedAt" IS NOT NULL) IS TRUE)  "approvedAt" IS NOT NULL             ->    68
 *                                                       ("approvedAt" IS NOT NULL) IS TRUE   -> 5,322
 *
 * So the queries must use that exact form too: see `isApproved` in `OrdersCollectionQuery.ts`.
 *
 * `CREATE STATISTICS` only adds a catalog entry. The statistics are filled by `ANALYZE`, which runs here (in the
 * migration, not in the background) so that they exist as soon as it is deployed: it reads a fixed-size sample of
 * the table (0.4 s on 649k accounts) and does not block reads or writes. After that, autovacuum keeps them up to
 * date like any other statistics. If the `ANALYZE` were skipped, plans would stay as they are today until the next
 * automatic one.
 */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      CREATE STATISTICS IF NOT EXISTS "collectives__host_approved" (mcv)
      ON "HostCollectiveId", (("approvedAt" IS NOT NULL) IS TRUE)
      FROM "Collectives"
    `);
    await queryInterface.sequelize.query(`ANALYZE "Collectives"`);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`DROP STATISTICS IF EXISTS "collectives__host_approved"`);
  },
};
