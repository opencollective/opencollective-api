'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "ConnectedAccounts"
      SET "deletedAt" = NOW(),
        "settings" = JSONB_SET(COALESCE("settings", '{}'), '{deletedFromMigration20250213115152}', 'true'::jsonb)
      WHERE "service" = 'twitter'
      AND "deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "ConnectedAccounts"
      SET "deletedAt" = NULL,
        "settings" = "settings" #- '{deletedFromMigration20250213115152}'
      WHERE "service" = 'twitter'
      AND "deletedAt" IS NOT NULL
      AND "settings" ? 'deletedFromMigration20250213115152'
    `);
  },
};
