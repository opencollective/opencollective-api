'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE
        "ConnectedAccounts"
      SET
        "deletedAt" = NULL,
        "settings" = JSONB_SET("data", '{needsReconnect}', 'true')
      WHERE
        "service" = 'twitter'
        AND "deletedAt" IS NOT NULL
        AND "data"->>'isArchivedLegacyTwitterOAuth' = 'true'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE
        "ConnectedAccounts"
      SET
        "deletedAt" = NOW(),
        "settings" = JSONB_SET("data", '{needsReconnect}', 'false')
      WHERE
        "service" = 'twitter'
        AND "deletedAt" IS NULL
        AND "settings"->>'isArchivedLegacyTwitterOAuth' = 'true'
    `);
  },
};
