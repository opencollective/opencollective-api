'use strict';

/**
 * Renames the legacy `Notifications` table to `ActivitySubscriptions` to match
 * the ActivitySubscription Sequelize model (`server/models/ActivitySubscription.ts`).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      BEGIN;
      ALTER TABLE "Notifications" RENAME TO "ActivitySubscriptions";
      CREATE VIEW "Notifications" AS SELECT * FROM "ActivitySubscriptions"; -- Alias the old table to the new one for backward compatibility
      COMMIT;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      BEGIN;
      DROP VIEW "Notifications";
      ALTER TABLE "ActivitySubscriptions" RENAME TO "Notifications";
      COMMIT;
    `);
  },
};
