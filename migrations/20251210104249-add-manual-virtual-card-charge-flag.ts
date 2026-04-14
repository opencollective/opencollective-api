'use strict';

import { QueryInterface } from 'sequelize';

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(`
      UPDATE "Expenses" e
      SET "data" = COALESCE("data", '{}'::jsonb) || '{"isManualVirtualCardCharge": true}'::jsonb
      FROM "TransactionsImportsRows" tir
      WHERE e."id" = tir."ExpenseId"
        AND e."type" = 'CHARGE'
    `);
  },

  down: async (queryInterface: QueryInterface) => {
    // Remove the flag from all expenses
    await queryInterface.sequelize.query(`
      UPDATE "Expenses"
      SET "data" = "data" - 'isManualVirtualCardCharge'
      WHERE "data"->>'isManualVirtualCardCharge' IS NOT NULL
    `);
  },
};
