'use strict';

import { QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS collective_search_index_include_archived
      ON "Collectives" USING GIN("searchTsVector")
      WHERE "deletedAt" IS NULL
        AND ("data" ->> 'hideFromSearch')::boolean IS NOT TRUE
        AND ("data" ->> 'isGuest')::boolean IS NOT TRUE
        AND name != 'incognito'
        AND name != 'anonymous'
        AND "isIncognito" = FALSE
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS collective_search_index_include_archived
    `);
  },
};
