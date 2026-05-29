'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" c
      SET data = c.data || '{"isGuest": false, "wasGuest": true, "updatedByMigration20260324135424": true}'
      FROM "Users" u
      WHERE u."CollectiveId" = c.id
      AND u."confirmedAt" IS NOT NULL
      AND u."lastLoginAt" IS NOT NULL
      AND c.data -> 'isGuest' = 'true'
      AND u."deletedAt" IS NULL
      AND c."deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" c
      SET data = data || '{"isGuest": true, "wasGuest": false}'
      WHERE data -> 'updatedByMigration20260324135424' = 'true'
    `);
  },
};
