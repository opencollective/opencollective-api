'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'PAYMENT_PROCESSOR_DISPUTE_FEE' AFTER 'PAYMENT_PROCESSOR_COVER'
    `);
  },

  async down() {
    // No rollback
  },
};
