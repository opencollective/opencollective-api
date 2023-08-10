'use strict';

/**
 * See https://github.com/opencollective/opencollective/issues/6870
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE
        "ConnectedAccounts"
      SET
        "deletedAt" = NOW(),
        "data" = JSONB_SET("data", '{isArchivedLegacyTwitterOAuth}', 'true')
      WHERE
        "service" = 'twitter'
        AND "deletedAt" IS NULL
        AND "clientId" IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE
        "ConnectedAccounts"
      SET
        "deletedAt" = NULL,
        "data" = JSONB_SET("data", '{isArchivedLegacyTwitterOAuth}', 'false')
      WHERE
        "service" = 'twitter'
        AND "deletedAt" IS NOT NULL
        AND "data"->>'isArchivedLegacyTwitterOAuth' = 'true'
    `);
  },
};
