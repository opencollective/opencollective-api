'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "isActive" = FALSE
      WHERE "isActive" = TRUE
      AND "type" in ('ORGANIZATION', 'USER')
    `);
  },

  down: () => {},
};
