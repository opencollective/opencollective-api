'use strict';

/**
 * Transactions were mistakinly linked to the user profile instead of the real
 * `FromCollectiveId`. This migration fixes 138 DEBIT transactions and their matching
 * CREDIT transactions.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Update DEBIT transactions
    const [_debitTransactions, debitResult] = await queryInterface.sequelize.query(`
      UPDATE ONLY "Transactions" t
      SET "FromCollectiveId" = e."FromCollectiveId"
      FROM "Expenses" e
      WHERE t."ExpenseId" IS NOT NULL
      AND t."ExpenseId" = e.id
      AND t."type" = 'DEBIT'
      AND t."FromCollectiveId" != e."FromCollectiveId" 
      -- Only look at problems related to the new expense flow
      AND DATE_PART('year', t."createdAt") >= 2020
    `);

    console.info(`Updated ${debitResult.rowCount} DEBIT transactions`);

    // Update CREDIT transactions
    const [_creditTransactions, creditResult] = await queryInterface.sequelize.query(`
      UPDATE ONLY "Transactions" t
      SET "CollectiveId" = e."FromCollectiveId"
      FROM "Expenses" e
      WHERE t."ExpenseId" IS NOT NULL
      AND t."ExpenseId" = e.id
      AND t."type" = 'CREDIT'
      AND t."CollectiveId" != e."FromCollectiveId" 
      -- Only look at problems related to the new expense flow
      AND DATE_PART('year', t."createdAt") >= 2020
    `);

    console.info(`Updated ${creditResult.rowCount} CREDIT transactions`);
  },

  down: async () => {
    /**
     * They'd be a risk of corrupting other data if we allow rollback on this one.
     */
  },
};
