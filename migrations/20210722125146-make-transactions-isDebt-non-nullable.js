'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 1. Set default value to FALSE (for newly created transactions)
    await queryInterface.changeColumn('Transactions', 'isDebt', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    });

    // 2. Update all NULL
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "isDebt" = FALSE
      WHERE "isDebt" IS NULL
    `);

    // 3. Set non-nullable
    await queryInterface.changeColumn('Transactions', 'isDebt', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  down: async (queryInterface, Sequelize) => {
    // We can remove the constraint, but we can't restore previous values
    await queryInterface.changeColumn('Transactions', 'isDebt', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    });
  },
};
