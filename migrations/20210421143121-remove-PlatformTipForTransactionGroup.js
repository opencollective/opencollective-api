'use strict';

module.exports = {
  up: async queryInterface => {
    // Migrate all existing platform tips to make sure their TransactionGroup are the same
    // as the transactions they're referring to.
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "TransactionGroup" = "PlatformTipForTransactionGroup"::uuid
      WHERE "PlatformTipForTransactionGroup" IS NOT NULL
      AND "PlatformTipForTransactionGroup"::uuid != "TransactionGroup"
      AND (data ->> 'isFeesOnTop')::boolean = TRUE
    `);

    // Remove `PlatformTipForTransactionGroup`
    await queryInterface.removeColumn('Transactions', 'PlatformTipForTransactionGroup');

    // Add an index on `TransactionGroup`, since we're going to use it more intensively from now on
    await queryInterface.addIndex('Transactions', ['TransactionGroup'], { concurrently: true });
  },

  down: async () => {
    // Nothing to do
  },
};
