'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Fix clearedAt for Stripe expense transactions where the Unix timestamp (seconds)
    // was incorrectly passed to new Date() which expects milliseconds.
    // This resulted in dates around January 1970 instead of the correct date.
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "clearedAt" = to_timestamp((data->'charge'->'balance_transaction'->>'available_on')::bigint)
      WHERE "ExpenseId" IS NOT NULL
        AND data->'charge'->'balance_transaction'->>'available_on' IS NOT NULL
        AND "clearedAt" < '1971-01-01'
    `);
  },

  async down() {
    // Not reversible - we don't want to revert to incorrect dates
  },
};
