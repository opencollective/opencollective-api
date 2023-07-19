'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Backup the values to `data` for the few rows that have a value
    await queryInterface.sequelize.query(`
      UPDATE "Expenses"
      SET "data" = jsonb_set(COALESCE("data", '{}'), '{legacyVAT}', to_jsonb("vat"))
      WHERE "vat" IS NOT NULL
    `);

    // Drop the column
    await queryInterface.removeColumn('Expenses', 'vat');
    await queryInterface.removeColumn('ExpenseHistories', 'vat');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('Expenses', 'vat', { type: Sequelize.NUMBER });
    await queryInterface.addColumn('ExpenseHistories', 'vat', { type: Sequelize.NUMBER });
  },
};
