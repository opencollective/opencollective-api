'use strict';

import type { DataTypes, QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize: typeof DataTypes) {
    await queryInterface.addColumn('Expenses', 'paidAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('ExpenseHistories', 'paidAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    // Backfill paidAt from the DEBIT/EXPENSE transaction's clearedAt (or createdAt)
    await queryInterface.sequelize.query(`
      UPDATE "Expenses" e
      SET "paidAt" = (
        SELECT COALESCE(t."clearedAt", t."createdAt")
        FROM "Transactions" t
        WHERE t."ExpenseId" = e.id
          AND t."type" = 'DEBIT'
          AND t."kind" = 'EXPENSE'
          AND t."isRefund" = false
          AND t."RefundTransactionId" IS NULL
          AND t."deletedAt" IS NULL
        LIMIT 1
      )
      WHERE e.status = 'PAID';
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "expenses__host_paid_at"
      ON "Expenses" ("HostCollectiveId", "paidAt" DESC NULLS LAST)
      WHERE "deletedAt" IS NULL AND "status" NOT IN ('DRAFT', 'SPAM');
    `);

    // Drop the old index that was only used for the correlated subquery in ORDER BY
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__expense_payment_date";
    `);
  },

  async down(queryInterface: QueryInterface) {
    // Restore the old index that supported the correlated subquery
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__expense_payment_date"
      ON "Transactions" ("ExpenseId", COALESCE("clearedAt", "createdAt"))
      WHERE "deletedAt" IS NULL
        AND "type" = 'DEBIT'
        AND "kind" = 'EXPENSE'
        AND "isRefund" = false
        AND "RefundTransactionId" IS NULL;
    `);
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "expenses__host_paid_at";
    `);
    await queryInterface.removeColumn('Expenses', 'paidAt');
    await queryInterface.removeColumn('ExpenseHistories', 'paidAt');
  },
};
