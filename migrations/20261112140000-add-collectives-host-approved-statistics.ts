'use strict';

import { QueryInterface } from 'sequelize';

/**
 * Planner statistics on the host of an account together with whether it is approved
 * (opencollective/opencollective#8947).
 *
 * The contributions of a host are those of the accounts with `"HostCollectiveId" = <host> AND "approvedAt" IS NOT
 * NULL`. PostgreSQL estimates the two conditions separately and multiplies them, but they are strongly correlated:
 * nearly all accounts are individuals, with neither a host nor an approval date. On 649k accounts, a host with 5,505
 * approved accounts was estimated at 63, and its 1.47M contributions at 250. The planner then read all of them to
 * sort them, where reading the most recent contributions first finds a page immediately: 4.3 s instead of 1 ms for the
 * first page of the host's incoming contributions, 4.0 s instead of 1.1 s for their total.
 *
 * The statistics are on the expression `("approvedAt" IS NOT NULL) IS TRUE` rather than on `"approvedAt"`: with one
 * distinct date per account, the most common (host, date) pairs say nothing about a host. Each host of some size has
 * its own (host, true) entry instead (estimate with the statistics: 5,823). PostgreSQL only uses them for conditions
 * written exactly like the expression: see `isApproved` in `OrdersCollectionQuery.ts`.
 *
 * They are filled by `ANALYZE` (run here), then kept up to date by autovacuum like any other statistics.
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
