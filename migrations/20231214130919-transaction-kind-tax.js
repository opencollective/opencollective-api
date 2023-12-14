'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'TAX' AFTER 'PREPAID_PAYMENT_METHOD'
    `);
  },

  async down() {
    // No rollback
  },
};
