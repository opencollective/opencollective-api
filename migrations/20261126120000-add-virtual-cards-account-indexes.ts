'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexesConcurrently, dropIndexesConcurrently } from './lib/concurrent-indexes';

/**
 * Indexes to find the virtual cards of an account (`CollectiveId`) or of a host (`HostCollectiveId`), part of
 * opencollective/opencollective#8642. "VirtualCards" only had its primary key and the `publicId` unique index, so every
 * lookup by account or host was a sequential scan. Main callers: the `VIRTUAL_CARDS` feature-status probes in
 * `server/graphql/common/features.ts` (the slowest feature checks in production), the `virtualCards` loaders,
 * `Account.virtualCards`, `Host.hostedVirtualCards` and the cleanup of `collectivelib.deleteCollective`.
 *
 * Partial on `"deletedAt" IS NULL`: the model is paranoid, so all these queries filter out the deleted cards.
 *
 * Measured on 50k virtual cards: the probes go from a sequential scan (~18 ms) to an index scan (< 0.1 ms). Each index
 * takes well under a second to build and less than 1 MB.
 *
 * Built with `CREATE INDEX CONCURRENTLY`: it holds a `SHARE UPDATE EXCLUSIVE` lock on "VirtualCards" (as `ANALYZE`
 * does), which blocks neither reads nor writes, only schema changes and `VACUUM` on that table. It waits for the
 * transactions that are open on the table when it starts.
 */

const INDEXES = [
  {
    table: 'VirtualCards',
    name: 'virtual_cards__collective_id',
    definition: `("CollectiveId")`,
    where: `"deletedAt" IS NULL`,
  },
  {
    table: 'VirtualCards',
    name: 'virtual_cards__host_collective_id',
    definition: `("HostCollectiveId")`,
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
