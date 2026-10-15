'use strict';

import { QueryInterface } from 'sequelize';

/**
 * Indexes for the PostgreSQL search provider, Comments (opencollective#8942).
 *
 * Expressions are copied from `CommentExpressions` in `server/lib/search/providers/postgres/expressions.ts` and must
 * stay identical to them.
 *
 * Built with `CREATE INDEX CONCURRENTLY` (one statement per query, serially) so that writes are not blocked. A failed
 * concurrent build leaves an INVALID index that `IF NOT EXISTS` would skip: check
 * `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid`, drop and re-run.
 */

const INDEXES: Array<{ table: string; name: string; definition: string; where: string | null }> = [
  {
    // Not partial on purpose: PostgreSQL only uses the statistics of non-partial expression indexes, which tell the
    // planner how many Comments a word matches (see `updates_pg_search_text`). Deleted Comments are filtered by the query.
    table: 'Comments',
    name: 'comments_pg_search_text',
    definition: `USING GIN (to_tsvector('public.oc_search_english'::regconfig, public.oc_search_html_to_text(coalesce(html, ''))))`,
    where: null,
  },
  {
    // Comments of an Account (Account scopes, administrators' own Accounts): there is no other "CollectiveId" index
    table: 'Comments',
    name: 'comments_pg_search_collective',
    definition: `USING BTREE ("CollectiveId")`,
    where: `"deletedAt" IS NULL`,
  },
  {
    // Comments written by an Account (Account scopes, authors)
    table: 'Comments',
    name: 'comments_pg_search_from',
    definition: `USING BTREE ("FromCollectiveId")`,
    where: `"deletedAt" IS NULL`,
  },
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    for (const index of INDEXES) {
      await queryInterface.sequelize.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ON "${index.table}" ${index.definition}${index.where ? ` WHERE ${index.where}` : ''}`,
      );
    }

    await queryInterface.sequelize.query(`ANALYZE "Comments"`);
  },

  async down(queryInterface: QueryInterface) {
    for (const index of INDEXES) {
      await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
    }
  },
};
