'use strict';

module.exports = {
  up: async queryInterface => {
    // Drop the existing search index
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "collective_search_index"`);

    // Re-create it with latest params
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS
        collective_search_index
      ON
        "Collectives"
      USING
        GIN((
          to_tsvector('english', name)
          || to_tsvector('simple', slug)
          || to_tsvector('english', COALESCE(description, ''))
          || COALESCE(array_to_tsvector(tags), '')
        ))
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
    // Drop the existing search index
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "collective_search_index"`);

    // Restore previous index
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS
        collective_search_index
      ON
        "Collectives"
      USING
        gin((
          to_tsvector('simple', name)
          || to_tsvector('simple', slug)
          || to_tsvector('simple', COALESCE(description, ''))
          || COALESCE(array_to_tsvector(tags), '')
          || to_tsvector('simple', COALESCE("longDescription", ''))
        ))
    `);
  },
};
