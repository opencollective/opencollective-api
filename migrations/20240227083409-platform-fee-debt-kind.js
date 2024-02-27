'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'PLATFORM_FEE_DEBT' AFTER 'PLATFORM_FEE'
    `);
  },

  async down() {
    // No rollback
  },
};
