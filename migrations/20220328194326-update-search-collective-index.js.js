'use strict';

module.exports = {
  up: async queryInterface => {
    // Create IMMUTABLE function for array to string conversion
    await queryInterface.createFunction(
      'array_to_string_immutable',
      [
        { type: 'text[]', name: 'textArray' },
        { type: 'text', name: 'text' },
      ],
      'text',
      'plpgsql',
      'RETURN array_to_string(textArray, text);',
      ['IMMUTABLE', 'STRICT', 'PARALLEL', 'SAFE'],
    );

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
          || COALESCE(to_tsvector('simple', array_to_string_immutable(COALESCE(tags::varchar[], ARRAY[]::varchar[]), ' ')), '')
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
          to_tsvector('english', name)
          || to_tsvector('simple', slug)
          || to_tsvector('english', COALESCE(description, ''))
          || COALESCE(array_to_tsvector(tags), '')
        ))
    `);

    // Drop IMMUTABLE function for array to string conversion
    await queryInterface.dropFunction('array_to_string_immutable', [
      { type: 'text[]', name: 'textArray' },
      { type: 'text', name: 'text' },
    ]);
  },
};
