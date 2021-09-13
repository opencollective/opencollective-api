'use strict';

module.exports = {
  up: async queryInterface => {
    // Move address to data
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "data" = JSONB_SET("data", '{address}', "settings" -> 'address')
      WHERE "settings" -> 'address' IS NOT NULL
    `);

    // Delete address from settings
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "settings" = JSONB_STRIP_NULLS(JSONB_SET("settings", '{address}', 'null', false))
      WHERE "settings" -> 'address' IS NOT NULL
    `);
  },

  down: async () => {
    // No need for rollback
  },
};
