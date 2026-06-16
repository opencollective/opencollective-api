'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_Transactions_kind"
      ADD VALUE IF NOT EXISTS 'PLATFORM_TIP_TRANSFER' AFTER 'PLATFORM_TIP_DEBT'
    `);
  },

  async down() {
    // Enum values cannot easily be removed in Postgres; intentionally not rolling back.
  },
};
