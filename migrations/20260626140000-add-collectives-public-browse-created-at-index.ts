'use strict';

import { QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS collectives_public_browse_created_at
      ON "Collectives" ("createdAt" DESC, id DESC)
      WHERE "deletedAt" IS NULL
        AND ("data" ->> 'hideFromSearch')::boolean IS NOT TRUE
        AND ("data" ->> 'isGuest')::boolean IS NOT TRUE
        AND name NOT IN ('incognito', 'anonymous')
        AND "isIncognito" = FALSE
        AND "isPrivate" IS FALSE
        AND "deactivatedAt" IS NULL
        AND "type" != 'VENDOR'
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS collectives_public_browse_created_at
    `);
  },
};
