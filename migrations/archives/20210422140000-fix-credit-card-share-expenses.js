'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Expenses"
      SET "FromCollectiveId" = "CollectiveId", "CollectiveId" = "FromCollectiveId"
      WHERE "type" = 'CHARGE';
    `);
  },

  down: async () => {
    // nop
  },
};
