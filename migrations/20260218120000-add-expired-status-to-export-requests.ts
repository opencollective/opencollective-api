'use strict';

import type { QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    // Add EXPIRED to the status enum
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_ExportRequests_status" ADD VALUE IF NOT EXISTS 'EXPIRED';
    `);
  },

  async down(queryInterface: QueryInterface) {
    // Removing enum values is not straightforward in PostgreSQL
    // We would need to recreate the enum, which is risky
    // Instead, we'll just update any EXPIRED records to FAILED
    await queryInterface.sequelize.query(`
      UPDATE "ExportRequests" SET status = 'FAILED' WHERE status = 'EXPIRED';
    `);
  },
};
