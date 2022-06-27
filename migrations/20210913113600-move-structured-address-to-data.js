'use strict';

module.exports = {
  up: async queryInterface => {
    // Move address to data
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "data" = JSONB_SET(COALESCE("data", '{}'), '{address}', "settings" -> 'address'),
        "settings" = "settings" #- '{address}'
      WHERE "settings" -> 'address' IS NOT NULL
    `);
  },

  down: async () => {
    // No need for rollback
  },
};
