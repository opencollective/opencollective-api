'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "isActive" = FALSE
      WHERE "isActive" = TRUE
      AND "type" in ('ORGANIZATION', 'USER')
    `);
  },

  down: async () => {
    // No rollback
  },
};
