'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Create column
    await queryInterface.addColumn('Expenses', 'feesPayer', {
      type: Sequelize.ENUM('COLLECTIVE', 'PAYEE'),
      defaultValue: 'COLLECTIVE',
      allowNull: true, // We initially allow null for this field while we migrate the data
    });

    await queryInterface.addColumn('ExpenseHistories', 'feesPayer', {
      type: Sequelize.ENUM('COLLECTIVE', 'PAYEE'),
      defaultValue: 'COLLECTIVE',
      allowNull: true,
    });

    // Set default value for existing entries
    await queryInterface.sequelize.query(`
      UPDATE "Expenses" SET "feesPayer" = 'COLLECTIVE'
    `);

    // Enforce non-null
    await queryInterface.sequelize.query(`
      ALTER TABLE "Expenses" ALTER COLUMN "feesPayer" SET NOT NULL
    `);
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Expenses', 'feesPayer');
    await queryInterface.removeColumn('ExpenseHistories', 'feesPayer');
  },
};
