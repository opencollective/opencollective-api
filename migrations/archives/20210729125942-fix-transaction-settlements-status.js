'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "TransactionSettlements" ts
      SET "status" = 'SETTLED'
      FROM "Expenses" e
      WHERE ts."ExpenseId" IS NOT NULL
      AND ts."ExpenseId" = e.id
      AND ts.status != 'SETTLED'
      AND e.status = 'PAID'
    `);
  },

  down: async () => {
    // Nothing to do here
  },
};
