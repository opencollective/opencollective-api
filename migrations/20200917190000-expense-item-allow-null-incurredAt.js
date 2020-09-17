'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(`
    ALTER TABLE "ExpenseItems" ALTER COLUMN "incurredAt" DROP NOT NULL
    `);
  },

  down: async (queryInterface, Sequelize) => {
    return queryInterface.sequelize.query(`
    ALTER TABLE "ExpenseItems" ALTER COLUMN "incurredAt" SET NOT NULL
    `);
  },
};
