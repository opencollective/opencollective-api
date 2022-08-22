'use strict';

module.exports = {
  up: async queryInterface => {
    // Drop the existing search index
    console.log('Dropping index...');
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "collective_search_index"
    `);

    // Not adding the column to the model itself, so we don't need to add it to the history
    console.log('Adding TS Vector column...');
    await queryInterface.sequelize.query(`
      ALTER TABLE "Collectives"
      ADD COLUMN "searchTsVector" tsvector
      GENERATED ALWAYS AS (
        SETWEIGHT(to_tsvector('simple', "slug"), 'A')
        || SETWEIGHT(to_tsvector('simple', "name"), 'B')
        || SETWEIGHT(to_tsvector('english', "name"), 'B')
        || SETWEIGHT(to_tsvector('english', COALESCE("description", '')), 'C')
        || SETWEIGHT(to_tsvector('english', COALESCE("longDescription", '')), 'C')
        || SETWEIGHT(to_tsvector('simple', array_to_string_immutable(COALESCE(tags, ARRAY[]::varchar[]), ' ')), 'C')
      ) STORED
    `);

    // Add TS vectors index
    console.log('Adding TS Vector index...');
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY collective_search_index
      ON "Collectives"
      USING GIN("searchTsVector")
      WHERE "deletedAt" IS NULL
      AND "deactivatedAt" IS NULL
      AND ("data" ->> 'isGuest')::boolean IS NOT TRUE
      AND ("data" ->> 'hideFromSearch')::boolean IS NOT TRUE
      AND name != 'incognito'
      AND name != 'anonymous'
      AND "isIncognito" = FALSE
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "collective_search_index"
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE "Collectives"
      DROP COLUMN "searchTsVector"
    `);
  },
};
