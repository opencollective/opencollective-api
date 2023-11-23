'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE
        "ConnectedAccounts"
      SET
        "settings" = JSONB_SET(COALESCE("settings", '{}'), '{needsReconnect}', 'false')
      WHERE service = 'twitter'
        AND (data ->> 'isOAuth2')::boolean = true
        AND (settings ->> 'needsReconnect')::boolean = true
    `);
  },

  async down() {
    console.log('No down migration needed');
  },
};
