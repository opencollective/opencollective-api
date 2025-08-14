'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TYPE "enum_Expenses_type" ADD VALUE 'PLATFORM_BILLING';`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_ExpenseHistories_type" ADD VALUE 'PLATFORM_BILLING';`);
  },

  async down() {},
};
