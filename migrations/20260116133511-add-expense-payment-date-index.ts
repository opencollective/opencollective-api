'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    // This index supports efficient sorting of expenses by their payment date
    // (when the transaction was cleared or created) in ExpensesCollectionQuery
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__expense_payment_date"
      ON "Transactions" ("ExpenseId", COALESCE("clearedAt", "createdAt"))
      WHERE "deletedAt" IS NULL 
        AND "type" = 'DEBIT' 
        AND "kind" = 'EXPENSE' 
        AND "isRefund" = false;
        AND t."RefundTransactionId" IS NULL
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__expense_payment_date";
    `);
  },
};
