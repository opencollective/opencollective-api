'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Fix missing ExpenseId on host fees
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET
        "ExpenseId" = inconsistencies.expected_expense_id,
        data = jsonb_set(data, '{addedExpenseIdFromMigration20240710090511}', 'true')
      FROM (
        SELECT t.id AS transaction_id, expense_transaction."ExpenseId" AS expected_expense_id
        FROM "Transactions" t
        INNER JOIN "Transactions" expense_transaction ON t."TransactionGroup" = expense_transaction."TransactionGroup" AND expense_transaction.kind = 'EXPENSE' AND expense_transaction.type = t.type
        WHERE t."ExpenseId" IS NULL
          AND t."OrderId" IS NULL
          AND t."deletedAt" IS NULL
          AND expense_transaction."deletedAt" IS NULL
          AND t.kind = 'HOST_FEE'
      ) AS inconsistencies
      WHERE "Transactions".id = inconsistencies.transaction_id
    `);
  },

  async down() {
    console.log('This migration is irreversible.');
  },
};
