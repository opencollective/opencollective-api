'use strict';

import { QueryInterface } from 'sequelize';

/**
 * Indexes for the PostgreSQL search provider, Accounts (opencollective#8937).
 *
 * Expressions and predicates are copied from `AccountExpressions` in
 * `server/lib/search/providers/postgres/expressions.ts` and must stay identical to them.
 *
 * Built with `CREATE INDEX CONCURRENTLY` (one statement per query, serially) so that writes are not blocked. A failed
 * concurrent build leaves an INVALID index that `IF NOT EXISTS` would skip: check
 * `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`, drop and re-run.
 */

const ELIGIBLE = `"deletedAt" IS NULL AND "isPrivate" = false AND "isIncognito" = false AND "deactivatedAt" IS NULL AND (data ->> 'hideFromSearch')::boolean IS NOT TRUE AND (data ->> 'isGuest')::boolean IS NOT TRUE AND name <> 'incognito' AND name <> 'anonymous'`;

const INDEXES = [
  {
    name: 'collectives_pg_search_public',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(name, '') || ' ' || replace(coalesce(slug, ''), '-', ' ') || ' ' || coalesce(description, '') || ' ' || coalesce(website, '') || ' ' || public.array_to_string_immutable(coalesce(tags, '{}')::text[], ' ') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", ''))))`,
    where: ELIGIBLE,
  },
  {
    name: 'collectives_pg_search_restricted',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, coalesce(name, '') || ' ' || replace(coalesce(slug, ''), '-', ' ') || ' ' || coalesce(description, '') || ' ' || coalesce(website, '') || ' ' || public.array_to_string_immutable(coalesce(tags, '{}')::text[], ' ') || ' ' || public.oc_search_html_to_text(coalesce("longDescription", '')) || ' ' || coalesce("legalName", '')))`,
    where: `${ELIGIBLE} AND "legalName" IS NOT NULL`,
  },
  {
    name: 'collectives_pg_search_label',
    definition: `USING GIN (to_tsvector('public.oc_search_simple'::regconfig, coalesce(name, '') || ' ' || replace(coalesce(slug, ''), '-', ' ')))`,
    where: ELIGIBLE,
  },
  {
    name: 'collectives_pg_search_name',
    definition: `USING BTREE (public.oc_search_normalize(name))`,
    where: ELIGIBLE,
  },
  {
    name: 'collectives_pg_search_name_trgm',
    definition: `USING GIN (public.oc_search_unaccent(name) gin_trgm_ops)`,
    where: ELIGIBLE,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    for (const index of INDEXES) {
      await queryInterface.sequelize.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ON "Collectives" ${index.definition} WHERE ${index.where}`,
      );
    }

    await queryInterface.sequelize.query(`ANALYZE "Collectives"`);
  },

  async down(queryInterface: QueryInterface) {
    for (const index of INDEXES) {
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    }
  },
};
