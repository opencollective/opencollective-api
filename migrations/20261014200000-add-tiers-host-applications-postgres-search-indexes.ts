'use strict';

import { QueryInterface } from 'sequelize';

import { createIndexConcurrently } from './lib/concurrent-indexes';

/**
 * Indexes for the PostgreSQL search provider, Tiers and Host Applications (opencollective#8943).
 *
 * Expressions and predicates are copied from `TierExpressions`, `HostApplicationExpressions` and
 * `ExcludedAccountExpressions` in
 * `server/lib/search/providers/postgres/expressions.ts` and must stay identical to them.
 *
 * Built with `CREATE INDEX CONCURRENTLY` (one statement per query, serially) so that writes are not blocked. A failed
 * concurrent build leaves an INVALID index: `createIndexConcurrently` drops it and builds it again on the next run.
 */

const LIVE = `"deletedAt" IS NULL`;

const INDEXES = [
  {
    // Deleted or private accounts, whose tiers and applications are excluded with an index-only anti-join
    // (`ExcludedAccountExpressions` / `isOwnedByEligibleAccount`)
    table: 'Collectives',
    name: 'collectives_pg_search_excluded',
    definition: `USING BTREE (id)`,
    where: `"deletedAt" IS NOT NULL OR "isPrivate" = true`,
  },
  {
    // Accounts actively hosted by a host, for host scopes on dependent entities without reading the "Collectives" heap
    table: 'Collectives',
    name: 'collectives_pg_search_hosted',
    definition: `USING BTREE ("HostCollectiveId", id)`,
    where: `"isActive" = true AND "deletedAt" IS NULL`,
  },
  {
    table: 'Tiers',
    name: 'tiers_pg_search_vector',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(name, '') || ' ' || replace(coalesce(slug, ''), '-', ' ') || ' ' || coalesce(description, '') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", ''))))`,
    where: LIVE,
  },
  {
    table: 'Tiers',
    name: 'tiers_pg_search_name',
    definition: `USING BTREE (public.oc_search_normalize(name))`,
    where: LIVE,
  },
  {
    table: 'Tiers',
    name: 'tiers_pg_search_slug',
    definition: `USING BTREE (slug)`,
    where: LIVE,
  },
  {
    table: 'HostApplications',
    name: 'host_applications_pg_search_message',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(message, '')))`,
    where: LIVE,
  },
  {
    // Applications of the accounts administered by the user
    table: 'HostApplications',
    name: 'host_applications__collective_id',
    definition: `USING BTREE ("CollectiveId")`,
    where: LIVE,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    for (const index of INDEXES) {
      await createIndexConcurrently(queryInterface, index);
    }

    await queryInterface.sequelize.query(`ANALYZE "Collectives"`);
    await queryInterface.sequelize.query(`ANALYZE "Tiers"`);
    await queryInterface.sequelize.query(`ANALYZE "HostApplications"`);
  },

  async down(queryInterface: QueryInterface) {
    for (const index of INDEXES) {
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    }
  },
};
