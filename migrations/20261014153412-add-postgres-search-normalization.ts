'use strict';

import { QueryInterface } from 'sequelize';

/**
 * Normalization primitives for the PostgreSQL search provider (opencollective#8937). Additive only: functions and
 * text search configurations, no table changes.
 *
 * The SQL expressions that use them are defined in `server/lib/search/providers/postgres/expressions.ts`; keep
 * both in sync (index expressions must match query expressions exactly).
 *
 * If these definitions ever change, every index that depends on them must be rebuilt (`REINDEX`).
 */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);

    // Some hosting providers install extensions in a dedicated schema (e.g. `heroku_ext`): reference the actual one
    const [[{ schema }]] = (await queryInterface.sequelize.query(`
      SELECT quote_ident(n.nspname) AS schema
      FROM pg_extension e
      INNER JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'unaccent'
    `)) as [Array<{ schema: string }>, unknown];

    // `unaccent()` is STABLE (it depends on search_path): this wrapper pins the dictionary so it can be used in indexes
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION public.oc_search_unaccent(text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
      AS $$ SELECT ${schema}.unaccent('${schema}.unaccent'::regdictionary, $1) $$
    `);

    // Labels (names, titles): accent-folded, lowercased, whitespace-collapsed. Used for exact label equality.
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION public.oc_search_normalize(text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
      AS $$ SELECT btrim(regexp_replace(lower(public.oc_search_unaccent($1)), '\\s+', ' ', 'g')) $$
    `);

    // HTML bodies: strip tags and common entities, bounded so that tsvectors stay well under the 1MB limit
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION public.oc_search_html_to_text(text) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
      AS $$ SELECT left(regexp_replace(regexp_replace(left($1, 1000000), '<[^>]*>', ' ', 'g'), '&(nbsp|amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);', ' ', 'g'), 200000) $$
    `);

    // Accent-folding text search configurations: "simple" for labels/prefixes, "english" (stemming) for prose
    await queryInterface.sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'oc_search_simple' AND cfgnamespace = 'public'::regnamespace) THEN
          CREATE TEXT SEARCH CONFIGURATION public.oc_search_simple (COPY = pg_catalog.simple);
          ALTER TEXT SEARCH CONFIGURATION public.oc_search_simple ALTER MAPPING FOR hword, hword_part, word WITH ${schema}.unaccent, simple;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'oc_search_english' AND cfgnamespace = 'public'::regnamespace) THEN
          CREATE TEXT SEARCH CONFIGURATION public.oc_search_english (COPY = pg_catalog.english);
          ALTER TEXT SEARCH CONFIGURATION public.oc_search_english ALTER MAPPING FOR hword, hword_part, word WITH ${schema}.unaccent, english_stem;
        END IF;
      END $$
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`DROP TEXT SEARCH CONFIGURATION IF EXISTS public.oc_search_english`);
    await queryInterface.sequelize.query(`DROP TEXT SEARCH CONFIGURATION IF EXISTS public.oc_search_simple`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS public.oc_search_html_to_text(text)`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS public.oc_search_normalize(text)`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS public.oc_search_unaccent(text)`);
    // The `unaccent` extension is left installed: it may be used elsewhere
  },
};
