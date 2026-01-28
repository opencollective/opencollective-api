'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Add BALANCE_CARRYFORWARD to the transaction kind enum
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'BALANCE_CARRYFORWARD' AFTER 'TAX'
    `);
  },

  async down() {
    // Cannot remove enum value in PostgreSQL
  },
};
