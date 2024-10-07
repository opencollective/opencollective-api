'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "description" = 'Financial contribution to the Open Collective Platform'
      WHERE "kind" = 'PLATFORM_TIP'
      AND "createdAt" >= '2024-10-01';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "description" = 'Financial contribution to Open Collective'
      WHERE "kind" = 'PLATFORM_TIP'
      AND "createdAt" >= '2024-10-01';
    `);
  },
};
