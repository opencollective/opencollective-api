'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    // Create index
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data_paypal_refund_id"
      ON "Transactions"
      USING BTREE (("data"#>>'{paypalRefundId}') ASC)
      WHERE "data"#>>'{paypalRefundId}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__data_paypal_refund_id";
    `);
  },
};
