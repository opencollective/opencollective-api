'use strict';

module.exports = {
  up: async function (queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "collective_search_index";`);
    await queryInterface.sequelize.query(`
      CREATE INDEX
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

  down: async function (queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "collective_search_index";`);
  },
};
