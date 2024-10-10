'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "description" = 'Platform Tip collected for the Open Collective platform'
      WHERE "kind" = 'PLATFORM_TIP_DEBT'
      AND "createdAt" >= '2024-10-01';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "description" = 'Platform Tip collected for Open Collective'
      WHERE "kind" = 'PLATFORM_TIP_DEBT'
      AND "createdAt" >= '2024-10-01';
    `);
  },
};
